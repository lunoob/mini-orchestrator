import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"

import { createActivity, type AgentActivity } from "../activity.js"
import type { AgentConfig } from "../../types.js"
import { splitCommand } from "../../lib/utils.js"

export type CodexNotification = { method: string; params: Record<string, unknown> }

export type CodexTransport = {
  close: () => Promise<void>
  onExit?: (listener: (error: Error) => void) => () => void
  onNotification: (listener: (notification: CodexNotification) => void) => () => void
  notify?: (method: string, params: Record<string, unknown>) => void
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>
  start: () => Promise<void>
}

export type CodexEvent = {
  data: Record<string, string>
  type: "output_item.done" | "output_text.delta" | "turn.completed" | "turn.failed" | "turn.interrupted"
} | {
  data: { activity: AgentActivity; turnId: string }
  type: "activity"
}

export type CodexAdapter = {
  flush: () => Promise<void>
  interrupt: (turnId: string) => Promise<void>
  sendMessage: (input: { content: string; turnId: string }) => Promise<void>
  start: () => Promise<void>
  stop: () => Promise<void>
}

type AdapterOptions = {
  agent: AgentConfig
  cwd: string
  emit: (event: CodexEvent) => Promise<void> | void
  onFailure?: (error: Error) => Promise<void> | void
  onNotification?: (notification: CodexNotification) => Promise<void> | void
  transport: CodexTransport
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined

/** 已知的 Codex App Server 工具 item 类型 */
const CODEX_TOOL_TYPES = new Set(["commandExecution", "fileChange", "mcpToolCall", "toolCall"])

/** 清理字符串：移除所有控制字符（包括换行），截断 */
const cleanString = (input: string, maxLen: number): string => {
  const cleaned = input.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "").replace(/[\r\n\t]/g, " ").trim()
  if (cleaned.length <= maxLen) return cleaned
  return `${cleaned.slice(0, maxLen - 3)}...`
}

/**
 * 从 Codex App Server 工具 item 构建安全 label。
 * 仅使用白名单字段，避免泄露命令参数、token 等敏感数据。
 */
const buildCodexToolLabel = (item: Record<string, unknown>): string => {
  const itemType = typeof item.type === "string" ? item.type : "unknown"
  const toolName = typeof item.name === "string" ? item.name : itemType

  // fileChange → 展示文件路径
  if (itemType === "fileChange") {
    const filePath = typeof item.path === "string" ? item.path
      : typeof item.filePath === "string" ? item.filePath
      : undefined
    return filePath ? `fileChange ${cleanString(filePath, 80)}` : "fileChange"
  }

  // mcpToolCall → 展示 MCP 工具名
  if (itemType === "mcpToolCall") {
    const mcpTool = typeof item.toolName === "string" ? item.toolName
      : typeof item.name === "string" ? item.name
      : undefined
    return mcpTool ? `mcp:${cleanString(mcpTool, 60)}` : "mcpToolCall"
  }

  // commandExecution → 仅展示工具名（不展示完整命令，避免泄露 token/密钥）
  if (itemType === "commandExecution") {
    // 从 command 中提取首个词作为工具名（如 bash, node 等）
    if (typeof item.command === "string") {
      const firstWord = item.command.split(/\s+/)[0]
      const base = firstWord ? cleanString(firstWord, 30) : "command"
      return `exec ${base}`
    }
    return "exec"
  }

  // toolCall / 其他 → 展示 name
  return cleanString(toolName, 60)
}

const createJsonRpcTransport = (agent: AgentConfig, cwd: string): CodexTransport => {
  const [command, ...commandArgs] = splitCommand(agent.command)
  if (!command) throw new Error("[Codex] Agent command is empty")

  let child: ChildProcessWithoutNullStreams | undefined
  let nextId = 0
  let buffer = ""
  const pending = new Map<number, { reject: (error: Error) => void; resolve: (value: unknown) => void }>()
  const listeners = new Set<(notification: CodexNotification) => void>()
  const exitListeners = new Set<(error: Error) => void>()
  let failed = false

  const fail = (error: Error) => {
    if (failed) return
    failed = true
    for (const request of pending.values()) request.reject(error)
    pending.clear()
    for (const listener of exitListeners) listener(error)
  }

  const start = async () => {
    child = spawn(command, command === "codex" ? ["app-server", "--stdio", ...commandArgs] : commandArgs, {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    })
    child.stdout.on("data", (chunk: Buffer | string) => {
      buffer += chunk.toString()
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) {
        if (!line.trim()) continue
        let message: Record<string, unknown>
        try {
          message = JSON.parse(line) as Record<string, unknown>
        } catch {
          continue
        }
        if (typeof message.id === "number" && ("result" in message || "error" in message)) {
          const request = pending.get(message.id)
          if (!request) continue
          pending.delete(message.id)
          if ("error" in message) request.reject(new Error(`[Codex] ${JSON.stringify(message.error)}`))
          else request.resolve(message.result)
          continue
        }
        if (typeof message.method === "string") {
          const params = asRecord(message.params) ?? {}
          for (const listener of listeners) listener({ method: message.method, params })
        }
      }
    })
    child.on("error", fail)
    child.on("close", code => {
      fail(new Error(`[Codex] app-server exited with code ${code}`))
    })
  }

  const request = (method: string, params: Record<string, unknown>) => new Promise<unknown>((resolve, reject) => {
    if (!child?.stdin.writable) {
      reject(new Error("[Codex] app-server is not running"))
      return
    }
    const id = ++nextId
    pending.set(id, { reject, resolve })
    child.stdin.write(`${JSON.stringify({ id, jsonrpc: "2.0", method, params })}\n`)
  })

  const notify = (method: string, params: Record<string, unknown>) => {
    if (!child?.stdin.writable) return
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`)
  }

  const close = async () => {
    if (!child) return
    child.kill()
    child = undefined
  }

  return {
    close,
    onExit: listener => {
      exitListeners.add(listener)
      return () => exitListeners.delete(listener)
    },
    onNotification: listener => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    notify,
    request,
    start,
  }
}

const threadIdFrom = (value: unknown) => asRecord(value)?.thread && asRecord(asRecord(value)?.thread)?.id

export const createCodexAdapter = (options: AdapterOptions): CodexAdapter => {
  const sent = new Set<string>()
  const localTurns = new Map<string, string>()
  const completedItems = new Set<string>()
  // 暂存 turn/start 响应到达前收到的通知，映射建立后重放
  const pendingTurns = new Set<string>()
  const pendingNotifications: CodexNotification[] = []
  let threadId: string | undefined
  let removeNotification: (() => void) | undefined
  let removeExit: (() => void) | undefined
  let notificationQueue = Promise.resolve()
  let exitHandled = false
  let failureReported = false

  const reportFailure = async (error: Error) => {
    if (failureReported) return
    failureReported = true
    try {
      await options.onFailure?.(error)
    } catch {
      // Failure reporting must not create an unhandled rejection in the stdout listener.
    }
  }

  const emit = async (event: CodexEvent) => options.emit(event)

  const handleNotification = async (notification: CodexNotification) => {
    await options.onNotification?.(notification)
    const { method, params } = notification
    const codexTurnId = typeof params.turnId === "string"
      ? params.turnId
      : asRecord(params.turn)?.id
    const localTurnId = typeof codexTurnId === "string"
      ? [...localTurns.entries()].find(([, id]) => id === codexTurnId)?.[0]
      : undefined
    // 有待定 turn 但通知无法匹配：暂存，等映射建立后重放
    if (!localTurnId && pendingTurns.size > 0) {
      pendingNotifications.push(notification)
      return
    }
    if (!localTurnId) return

    if (method === "item/agentMessage/delta" && typeof params.delta === "string") {
      await emit({ data: { delta: params.delta, turnId: localTurnId }, type: "output_text.delta" })
      return
    }
    // item/started — tool item 开始（commandExecution, fileChange, mcpToolCall, toolCall）
    if (method === "item/started") {
      const item = asRecord(params.item)
      if (item && typeof item.type === "string" && CODEX_TOOL_TYPES.has(item.type)) {
        const label = buildCodexToolLabel(item)
        await emit({ data: { activity: createActivity("tool_started", label, localTurnId), turnId: localTurnId }, type: "activity" })
      }
      return
    }
    if (method === "item/completed") {
      const item = asRecord(params.item)
      if (!item) return
      // agentMessage → 输出文本
      if (item.type === "agentMessage" && typeof item.text === "string" && typeof item.id === "string" && !completedItems.has(item.id)) {
        completedItems.add(item.id)
        await emit({ data: { content: item.text, turnId: localTurnId }, type: "output_item.done" })
        return
      }
      // 工具 item completed/failed → 工具活动
      if (typeof item.type === "string" && CODEX_TOOL_TYPES.has(item.type)) {
        const label = buildCodexToolLabel(item)
        const status = typeof item.status === "string" ? item.status : "completed"
        if (status === "failed") {
          const rawError = typeof item.error === "string" ? item.error : undefined
          const detail = rawError ? cleanString(rawError, 120) : undefined
          await emit({ data: { activity: createActivity("tool_failed", label, localTurnId, detail), turnId: localTurnId }, type: "activity" })
        } else {
          await emit({ data: { activity: createActivity("tool_completed", label, localTurnId), turnId: localTurnId }, type: "activity" })
        }
      }
      return
    }
    if (method === "turn/completed") {
      const status = asRecord(params.turn)?.status
      if (status === "interrupted") await emit({ data: { turnId: localTurnId }, type: "turn.interrupted" })
      else if (status === "failed") {
        const error = asRecord(asRecord(params.turn)?.error)
        const rawReason = typeof error?.message === "string" ? error.message : "Codex turn failed"
        const reason = cleanString(rawReason, 120)
        await emit({ data: { reason, turnId: localTurnId }, type: "turn.failed" })
      } else if (status === "completed") await emit({ data: { turnId: localTurnId }, type: "turn.completed" })
    }
  }

  const enqueueNotification = (notification: CodexNotification) => {
    notificationQueue = notificationQueue
      .then(() => handleNotification(notification))
      .catch(error => reportFailure(error instanceof Error ? error : new Error(String(error))))
    return notificationQueue
  }

  const start = async () => {
    await options.transport.start()
    removeNotification = options.transport.onNotification(notification => { void enqueueNotification(notification) })
    removeExit = options.transport.onExit?.(error => {
      void (async () => {
        if (exitHandled) return
        exitHandled = true
        try {
          await notificationQueue
          for (const turnId of localTurns.keys()) {
            await emit({ data: { reason: error.message, turnId }, type: "turn.failed" })
          }
          await reportFailure(error)
        } catch (exitError) {
          await reportFailure(exitError instanceof Error ? exitError : new Error(String(exitError)))
        }
      })()
    })
    await options.transport.request("initialize", {
      capabilities: {},
      clientInfo: { name: "mini-orch-session-runner", version: "0.1.7" },
    })
    options.transport.notify?.("initialized", {})
    const result = await options.transport.request("thread/start", { cwd: options.cwd, model: options.agent.model ?? null })
    const id = threadIdFrom(result)
    if (typeof id !== "string") throw new Error("[Codex] thread/start returned no thread id")
    threadId = id
  }

  const sendMessage = async ({ content, turnId }: { content: string; turnId: string }) => {
    if (sent.has(turnId)) return
    if (!threadId) throw new Error("[Codex] Adapter is not ready")
    sent.add(turnId)
    // The app-server may flush notifications in the same stdout chunk as the response.
    // Install a fallback mapping before awaiting the request so early deltas are not lost.
    localTurns.set(turnId, `codex-${turnId}`)
    pendingTurns.add(turnId)
    try {
      const result = await options.transport.request("turn/start", {
        clientUserMessageId: turnId,
        input: [{ text: content, type: "text" }],
        effort: options.agent.effort ?? null,
        threadId,
      })
      const codexTurnId = asRecord(asRecord(result)?.turn)?.id
      localTurns.set(turnId, typeof codexTurnId === "string" ? codexTurnId : `codex-${turnId}`)
      pendingTurns.delete(turnId)
      // 重放映射建立前暂存的通知
      if (pendingNotifications.length > 0) {
        const replay = pendingNotifications.splice(0)
        for (const n of replay) await enqueueNotification(n)
      }
    } catch (error) {
      pendingTurns.delete(turnId)
      pendingNotifications.length = 0
      sent.delete(turnId)
      await emit({ data: { reason: error instanceof Error ? error.message : String(error), turnId }, type: "turn.failed" })
      throw error
    }
  }

  const interrupt = async (turnId: string) => {
    if (!threadId) return
    const codexTurnId = localTurns.get(turnId)
    if (!codexTurnId) return
    await options.transport.request("turn/interrupt", { threadId, turnId: codexTurnId })
  }

  const stop = async () => {
    removeNotification?.()
    removeExit?.()
    await notificationQueue
    await options.transport.close()
  }

  return { flush: () => notificationQueue, interrupt, sendMessage, start, stop }
}

export const createDefaultCodexAdapter = (
  options: Omit<AdapterOptions, "transport">,
) => createCodexAdapter({ ...options, transport: createJsonRpcTransport(options.agent, options.cwd) })
