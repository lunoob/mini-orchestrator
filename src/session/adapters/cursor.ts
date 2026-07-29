import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"

import type { AgentConfig } from "../../types.js"
import type { AdapterEvent, AdapterOptions, SessionAdapter } from "./types.js"

/** Cursor transport 发出的原始事件，与 Claude transport 同构 */
type CursorRawEvent = {
  done?: boolean
  failed?: boolean
  interrupted?: boolean
  text?: string
  turnId: string
}

export type CursorTransport = {
  cancel: (turnId: string) => Promise<void>
  close: () => Promise<void>
  onEvent: (listener: (event: CursorRawEvent) => void) => () => void
  onExit?: (listener: (error: Error) => void) => () => void
  /** Cursor 不支持独立的 effort 参数；思考强度已写入 model suffix */
  send: (params: { content: string; model?: string }) => Promise<{ turnId: string }>
  start: (params: { model?: string }) => Promise<void>
}

type CreateOptions = AdapterOptions & {
  onEvent?: (event: AdapterEvent) => Promise<void> | void
  transport: CursorTransport
}

const validateCursorConfig = (agent: AgentConfig) => {
  if (agent.effort !== undefined) {
    throw new Error(
      `[Cursor] effort is not supported for agent "${agent.name}". ` +
        `Use model suffix instead (e.g. composer-2.5-high). ` +
        `Found effort="${agent.effort}" in config for "${agent.name}".`,
    )
  }
}

export const createCursorAdapter = (options: CreateOptions): SessionAdapter => {
  validateCursorConfig(options.agent)

  const eventListeners = new Set<(event: AdapterEvent) => void>()
  const sent = new Set<string>()
  const localToCursorTurn = new Map<string, string>()
  const cursorToLocalTurn = new Map<string, string>()
  let removeTransportEvent: (() => void) | undefined
  let removeExit: (() => void) | undefined
  let exitHandled = false
  let pendingQueue = Promise.resolve()

  const emit = async (event: AdapterEvent) => {
    for (const listener of eventListeners) await listener(event)
    await options.onEvent?.(event)
  }

  const enqueue = (task: () => Promise<void>) => {
    pendingQueue = pendingQueue.then(task).catch(() => undefined)
    return pendingQueue
  }

  const handleEvent = async (raw: CursorRawEvent) => {
    const localTurnId = cursorToLocalTurn.get(raw.turnId)
    if (!localTurnId) return

    if (raw.failed) {
      await emit({ data: { reason: raw.text ?? "Cursor turn failed", turnId: localTurnId }, type: "turn.failed" })
      localToCursorTurn.delete(localTurnId)
      cursorToLocalTurn.delete(raw.turnId)
      return
    }
    if (raw.interrupted) {
      await emit({ data: { turnId: localTurnId }, type: "turn.interrupted" })
      localToCursorTurn.delete(localTurnId)
      cursorToLocalTurn.delete(raw.turnId)
      return
    }
    if (raw.done) {
      await emit({ data: { turnId: localTurnId }, type: "turn.completed" })
      localToCursorTurn.delete(localTurnId)
      cursorToLocalTurn.delete(raw.turnId)
      return
    }
    if (raw.text !== undefined) {
      await emit({ data: { delta: raw.text, turnId: localTurnId }, type: "output_text.delta" })
    }
  }

  const handleExit = async (error: Error) => {
    if (exitHandled) return
    exitHandled = true
    await pendingQueue
    for (const [localTurnId] of localToCursorTurn) {
      await emit({ data: { reason: error.message, turnId: localTurnId }, type: "turn.failed" })
    }
    localToCursorTurn.clear()
    cursorToLocalTurn.clear()
    try {
      await options.onFailure?.(error)
    } catch {
      // failure reporting must not create unhandled rejections
    }
  }

  const start = async () => {
    await options.transport.start({ model: options.agent.model })
    removeTransportEvent = options.transport.onEvent(raw => { void enqueue(() => handleEvent(raw)) })
    removeExit = options.transport.onExit?.(error => { void handleExit(error) })
  }

  const deliverMessage = async ({ content, turnId }: { content: string; turnId: string }) => {
    if (sent.has(turnId)) return
    sent.add(turnId)
    try {
      const { turnId: cursorTurnId } = await options.transport.send({
        content,
        model: options.agent.model,
      })
      localToCursorTurn.set(turnId, cursorTurnId)
      cursorToLocalTurn.set(cursorTurnId, turnId)
    } catch (error) {
      sent.delete(turnId)
      await emit({
        data: { reason: error instanceof Error ? error.message : String(error), turnId },
        type: "turn.failed",
      })
      throw error
    }
  }

  const interrupt = async (turnId: string) => {
    const cursorTurnId = localToCursorTurn.get(turnId)
    if (!cursorTurnId) return
    await options.transport.cancel(cursorTurnId)
  }

  const stop = async () => {
    removeTransportEvent?.()
    removeExit?.()
    await pendingQueue
    await options.transport.close()
  }

  const dispose = async () => {
    await stop()
    eventListeners.clear()
    sent.clear()
    localToCursorTurn.clear()
    cursorToLocalTurn.clear()
  }

  const onEvent = (listener: (event: AdapterEvent) => void) => {
    eventListeners.add(listener)
    return () => { eventListeners.delete(listener) }
  }

  return { deliverMessage, dispose, interrupt, onEvent, start, stop }
}

// ---- 真实 Cursor CLI transport ----

const extractCliName = (command: string) => command.split(/\s+/)[0]

/** 获取 Cursor assistant 消息中的纯文本拼接 */
const extractCursorText = (message: Record<string, unknown> | undefined) => {
  if (!message) return ""
  const content = Array.isArray(message.content) ? message.content : []
  return (content as Array<Record<string, unknown>>)
    .filter(block => block.type === "text" && typeof block.text === "string")
    .map(block => block.text as string)
    .join("")
}

export const createCursorTransport = (agent: AgentConfig, cwd: string): CursorTransport => {
  const eventListeners = new Set<(event: CursorRawEvent) => void>()
  const exitListeners = new Set<(error: Error) => void>()
  // 首 turn 完成后保存 session_id，后续 turn 使用 --resume 续聊
  let sessionId: string | undefined
  let nextTurnId = 0
  let activeTurnId: string | undefined
  // 当前活跃进程（每个 turn 独立启动）
  let child: ChildProcessWithoutNullStreams | undefined
  let cancellingTurn: string | undefined

  const emit = (event: CursorRawEvent) => {
    for (const listener of eventListeners) listener(event)
  }

  const start = async () => {
    // Cursor transport 在 send 时按需启动进程，start 仅做无操作初始化
  }

  /** 为当前 turn 启动一个新的 cursor-agent --print 进程 */
  const launchProcess = (turnId: string, content: string) => {
    const cliName = extractCliName(agent.command)
    if (!cliName) throw new Error("[Cursor] Agent command is empty")
    // 官方 headless 调用：--print 非交互模式 + stream-json 输出
    const args = ["--print", "--output-format", "stream-json"]
    if (agent.model) args.push("--model", agent.model)
    // 非首 turn：使用 --resume 续聊
    if (sessionId) args.push("--resume", sessionId)
    // prompt 作为位置参数传入
    args.push(content)

    const proc = spawn(cliName, args, { cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] })
    let buffer = ""
    // 追踪是否收到终态 result，防止进程 code=0 退出但未输出 result 导致 turn 永久等待
    let resolved = false
    // 进程启动后关闭 stdin，表示输入结束
    proc.stdin.end()

    proc.stdout.on("data", (chunk: Buffer | string) => {
      buffer += chunk.toString()
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const msg = JSON.parse(line) as Record<string, unknown>
          // system 事件 → 捕获 session_id 用于后续 --resume
          if (msg.type === "system") {
            if (typeof msg.session_id === "string") sessionId = msg.session_id
            continue
          }
          // user 事件 → 跳过
          if (msg.type === "user") continue

          // assistant 事件 → 文本为增量 chunk，直接作为 delta 发射
          if (msg.type === "assistant") {
            const text = extractCursorText(msg.message as Record<string, unknown> | undefined)
            if (text) emit({ text, turnId })
            continue
          }

          // result 事件 → 终态
          if (msg.type === "result") {
            resolved = true
            if (msg.is_error || msg.subtype === "error_during_execution") {
              const errMsg = typeof msg.error === "string" ? msg.error : "Cursor execution error"
              emit({ failed: true, text: errMsg, turnId })
            } else {
              emit({ done: true, turnId })
            }
            continue
          }

          // 协议级错误 → 终止进程并上报
          if (msg.type === "error") {
            proc.kill()
            for (const listener of exitListeners) {
              listener(new Error(`[Cursor] Protocol error: ${JSON.stringify(msg.error ?? msg)}`))
            }
          }
        } catch {
          // 非 JSON 行静默跳过
        }
      }
    })

    proc.stderr.on("data", (chunk: Buffer | string) => {
      process.stderr.write(`[Cursor stderr] ${chunk.toString()}`)
    })

    proc.on("error", error => {
      for (const listener of exitListeners) listener(error)
    })

    proc.on("close", (code, signal) => {
      if (child !== proc) return
      // 已记录的取消信号 → turn.interrupted
      if (signal !== null && cancellingTurn === turnId) {
        resolved = true
        emit({ interrupted: true, turnId })
        cancellingTurn = undefined
        child = undefined
        return
      }
      // 其他信号退出 → 活跃 turn 上报失败，并触发进程级失败
      if (signal !== null) {
        resolved = true
        emit({ failed: true, text: `Process killed by signal ${signal}`, turnId })
        cancellingTurn = undefined
        child = undefined
        for (const listener of exitListeners) {
          listener(new Error(`[Cursor] Process killed by signal ${signal}`))
        }
        return
      }
      // 进程退出但未收到 result → 结构化流异常结束，上报失败并触发进程级失败
      if (!resolved) {
        emit({ failed: true, text: `Process exited with code ${code ?? "null"} without emitting result`, turnId })
        child = undefined
        for (const listener of exitListeners) {
          listener(new Error(`[Cursor] Process exited with code ${code ?? "null"} without emitting result`))
        }
        return
      }
      // 非 0 退出码 → 异常（result 事件已收到时的进程级错误）
      if (code !== 0) {
        for (const listener of exitListeners) {
          listener(new Error(`[Cursor] Process exited with code ${code}`))
        }
      }
      child = undefined
    })

    return proc
  }

  const send = async (params: { content: string; model?: string }) => {
    // 关闭上一个进程（应已在 result 后退出）
    if (child) {
      child.kill()
      child = undefined
    }
    nextTurnId += 1
    const turnId = `cursor-turn-${nextTurnId}`
    activeTurnId = turnId
    child = launchProcess(turnId, params.content)
    return { turnId }
  }

  const cancel = async (turnId: string) => {
    if (!child || activeTurnId !== turnId) return
    cancellingTurn = turnId
    child.kill("SIGTERM")
  }

  const close = async () => {
    if (!child) return
    child.kill()
    child = undefined
  }

  return {
    cancel,
    close,
    onEvent: listener => {
      eventListeners.add(listener)
      return () => { eventListeners.delete(listener) }
    },
    onExit: listener => {
      exitListeners.add(listener)
      return () => { exitListeners.delete(listener) }
    },
    send,
    start,
  }
}
