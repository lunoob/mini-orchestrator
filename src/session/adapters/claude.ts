import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"

import type { AgentConfig } from "../../types.js"
import type { AdapterEvent, AdapterOptions, SessionAdapter } from "./types.js"

/** Claude 支持的 reasoning effort 级别 */
const CLAUDE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const

/** Claude transport 发出的原始事件 */
type ClaudeRawEvent = {
  done?: boolean
  failed?: boolean
  interrupted?: boolean
  text?: string
  turnId: string
}

/** 注入 adapter 的 transport 契约 */
export type ClaudeTransport = {
  cancel: (turnId: string) => Promise<void>
  close: () => Promise<void>
  onEvent: (listener: (event: ClaudeRawEvent) => void) => () => void
  onExit?: (listener: (error: Error) => void) => () => void
  send: (params: { content: string; effort?: string; model?: string }) => Promise<{ turnId: string }>
  start: (params: { effort?: string; model?: string }) => Promise<void>
}

type CreateOptions = AdapterOptions & {
  onEvent?: (event: AdapterEvent) => Promise<void> | void
  transport: ClaudeTransport
}

const CLAUDE_EFFORT_SET: ReadonlySet<string> = new Set(CLAUDE_EFFORT_LEVELS)

const validateClaudeConfig = (agent: AgentConfig) => {
  if (agent.effort !== undefined && !CLAUDE_EFFORT_SET.has(agent.effort)) {
    throw new Error(
      `[Claude] Invalid effort "${agent.effort}" for agent "${agent.name}". ` +
        `Supported: ${CLAUDE_EFFORT_LEVELS.join(", ")}`,
    )
  }
}

export const createClaudeAdapter = (options: CreateOptions): SessionAdapter => {
  const eventListeners = new Set<(event: AdapterEvent) => void>()
  const sent = new Set<string>()
  const localToClaudeTurn = new Map<string, string>()
  const claudeToLocalTurn = new Map<string, string>()
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

  const handleEvent = async (raw: ClaudeRawEvent) => {
    const localTurnId = claudeToLocalTurn.get(raw.turnId)
    if (!localTurnId) return

    if (raw.failed) {
      await emit({ data: { reason: raw.text ?? "Claude turn failed", turnId: localTurnId }, type: "turn.failed" })
      localToClaudeTurn.delete(localTurnId)
      claudeToLocalTurn.delete(raw.turnId)
      return
    }
    if (raw.interrupted) {
      await emit({ data: { turnId: localTurnId }, type: "turn.interrupted" })
      localToClaudeTurn.delete(localTurnId)
      claudeToLocalTurn.delete(raw.turnId)
      return
    }
    if (raw.done) {
      await emit({ data: { turnId: localTurnId }, type: "turn.completed" })
      localToClaudeTurn.delete(localTurnId)
      claudeToLocalTurn.delete(raw.turnId)
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
    for (const [localTurnId] of localToClaudeTurn) {
      await emit({ data: { reason: error.message, turnId: localTurnId }, type: "turn.failed" })
    }
    localToClaudeTurn.clear()
    claudeToLocalTurn.clear()
    try {
      await options.onFailure?.(error)
    } catch {
      // failure reporting must not create unhandled rejections
    }
  }

  const start = async () => {
    validateClaudeConfig(options.agent)
    await options.transport.start({ effort: options.agent.effort, model: options.agent.model })
    removeTransportEvent = options.transport.onEvent(raw => { void enqueue(() => handleEvent(raw)) })
    removeExit = options.transport.onExit?.(error => { void handleExit(error) })
  }

  const deliverMessage = async ({ content, turnId }: { content: string; turnId: string }) => {
    if (sent.has(turnId)) return
    sent.add(turnId)
    try {
      const { turnId: claudeTurnId } = await options.transport.send({
        content,
        effort: options.agent.effort,
        model: options.agent.model,
      })
      localToClaudeTurn.set(turnId, claudeTurnId)
      claudeToLocalTurn.set(claudeTurnId, turnId)
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
    const claudeTurnId = localToClaudeTurn.get(turnId)
    if (!claudeTurnId) return
    await options.transport.cancel(claudeTurnId)
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
    localToClaudeTurn.clear()
    claudeToLocalTurn.clear()
  }

  const onEvent = (listener: (event: AdapterEvent) => void) => {
    eventListeners.add(listener)
    return () => { eventListeners.delete(listener) }
  }

  return { deliverMessage, dispose, interrupt, onEvent, start, stop }
}

// ---- 真实 Claude CLI transport ----

/** 从 command 字符串中提取 CLI 名称 */
const extractCliName = (command: string) => command.split(/\s+/)[0]

export const createClaudeTransport = (agent: AgentConfig, cwd: string): ClaudeTransport => {
  let child: ChildProcessWithoutNullStreams | undefined
  let buffer = ""
  const eventListeners = new Set<(event: ClaudeRawEvent) => void>()
  const exitListeners = new Set<(error: Error) => void>()
  let failed = false
  let nextTurnId = 0
  let activeTurnId: string | undefined
  let cancellingTurn: string | undefined

  const fail = (error: Error) => {
    if (failed) return
    failed = true
    // 终止底层 CLI 子进程，防止协议错误后进程残留
    child?.kill()
    child = undefined
    for (const listener of exitListeners) listener(error)
  }

  const emit = (event: ClaudeRawEvent) => {
    for (const listener of eventListeners) listener(event)
  }

  const start = async () => {
    const cliName = extractCliName(agent.command)
    if (!cliName) throw new Error("[Claude] Agent command is empty")
    // Claude Code 官方 headless 流式协议：--print 非交互模式 + stream-json + verbose
    const args = [
      "--print",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
    ]
    if (agent.model) args.push("--model", agent.model)
    if (agent.effort) args.push("--effort", agent.effort)
    child = spawn(cliName, args, { cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] })

    child.stdout.on("data", (chunk: Buffer | string) => {
      buffer += chunk.toString()
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const msg = JSON.parse(line) as Record<string, unknown>
          // system init → 捕获 session_id，不产生 turn 事件
          if (msg.type === "system") continue
          // user 事件（tool result 回显）→ 静默跳过，等待下一个 assistant
          if (msg.type === "user") continue

          // stream_event 官方流式文本 delta（需 --verbose --include-partial-messages）
          if (msg.type === "stream_event" && activeTurnId) {
            const event = msg.event as Record<string, unknown> | undefined
            const delta = event?.delta as Record<string, unknown> | undefined
            if (delta?.type === "text_delta" && typeof delta.text === "string") {
              emit({ text: delta.text, turnId: activeTurnId })
            }
            continue
          }

          // result 事件 → 终态，根据 subtype/is_error 映射
          if (msg.type === "result" && activeTurnId) {
            const turnId = activeTurnId
            activeTurnId = undefined
            if (msg.is_error || msg.subtype === "error_during_execution") {
              const errMsg = typeof msg.error === "string" ? msg.error : "Claude execution error"
              emit({ failed: true, text: errMsg, turnId })
            } else {
              emit({ done: true, turnId })
            }
            continue
          }

          // 协议级错误 → 标记 transport 失败
          if (msg.type === "error") {
            fail(new Error(`[Claude] Protocol error: ${JSON.stringify(msg.error ?? msg)}`))
          }
        } catch {
          // 非 JSON 行静默跳过
        }
      }
    })

    child.stderr.on("data", (chunk: Buffer | string) => {
      process.stderr.write(`[Claude stderr] ${chunk.toString()}`)
    })

    child.on("error", fail)
    child.on("close", (code, signal) => {
      // 已记录的取消信号 → turn.interrupted
      if (signal !== null && cancellingTurn && activeTurnId === cancellingTurn) {
        emit({ interrupted: true, turnId: cancellingTurn })
        cancellingTurn = undefined
        activeTurnId = undefined
        return
      }
      // 其他信号退出（如 SIGKILL）→ 活跃 turn 上报失败，并触发进程级失败
      if (signal !== null && activeTurnId) {
        const turnId = activeTurnId
        activeTurnId = undefined
        cancellingTurn = undefined
        emit({ failed: true, text: `Process killed by signal ${signal}`, turnId })
        fail(new Error(`[Claude] Process killed by signal ${signal}`))
        return
      }
      // 进程退出但活跃 turn 未收到 result → 结构化流异常结束，上报失败并触发进程级失败
      if (activeTurnId) {
        const turnId = activeTurnId
        activeTurnId = undefined
        cancellingTurn = undefined
        emit({ failed: true, text: `Process exited with code ${code ?? "null"} without emitting result`, turnId })
        fail(new Error(`[Claude] Process exited with code ${code ?? "null"} without emitting result`))
        return
      }
      // 非 0 退出码 → 异常（无活跃 turn 时的进程级错误）
      if (code !== 0 && code !== null) {
        fail(new Error(`[Claude] Process exited with code ${code}`))
      }
    })
  }

  const send = async (params: { content: string; effort?: string; model?: string }) => {
    if (!child?.stdin.writable) throw new Error("[Claude] Transport is not started")
    nextTurnId += 1
    const turnId = `claude-turn-${nextTurnId}`
    activeTurnId = turnId
    // Claude Code 官方 stream-json 输入格式
    const message = {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: params.content }],
      },
    }
    child.stdin.write(`${JSON.stringify(message)}\n`)
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
