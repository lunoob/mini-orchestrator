import { readFile, writeFile } from "node:fs/promises"

import type { SessionClient } from "./client.js"
import type { SessionInputEvent, SessionItem, SessionStreamEvent } from "./types.js"

export type RunnerMessage = { content: string; eventId: string; turnId: string }

export type RunnerClient = {
  consumeOnce: () => Promise<void>
  run: () => Promise<void>
  stop: () => void
}

type RunnerClientOptions = {
  client: Pick<SessionClient, "getItems" | "postEvent" | "stream">
  onInterrupt?: (turnId: string) => Promise<void>
  onMessage: (message: RunnerMessage) => Promise<void>
  onReady?: () => void
  onStop?: () => Promise<void>
  sessionId: string
  statePath?: string
}

const isTurnStarted = (event: SessionStreamEvent) => event.type === "turn.started" && Boolean(event.turnId)

const eventFor = (event: SessionInputEvent): SessionInputEvent => event

export const createRunnerClient = (options: RunnerClientOptions): RunnerClient => {
  const confirmed = new Set<string>()
  const interrupted = new Set<string>()
  let stopped = false
  let loaded = false
  // 等待 Codex 终态事件期间的状态
  let stoppingTurnId: string | undefined
  let stopTimer: ReturnType<typeof setTimeout> | undefined
  let activeIterator: AsyncIterator<SessionStreamEvent> | undefined

  const loadState = async () => {
    if (loaded || !options.statePath) return
    loaded = true
    try {
      const saved = JSON.parse(await readFile(options.statePath, "utf8")) as { confirmed?: string[] }
      for (const eventId of saved.confirmed ?? []) confirmed.add(eventId)
    } catch {
      // Missing state is the normal first-run path.
    }
  }

  const saveState = async () => {
    if (!options.statePath) return
    await writeFile(options.statePath, JSON.stringify({ confirmed: [...confirmed] }), "utf8")
  }

  const register = async () => {
    await options.client.postEvent(options.sessionId, eventFor({ source: "runner", type: "runner.ready" }))
    options.onReady?.()
  }

  const dispatchItem = async (item: SessionItem) => {
    if (item.role !== "user" || !item.eventId || confirmed.has(item.eventId)) return
    await options.onMessage({ content: item.content, eventId: item.eventId, turnId: item.turnId })
    confirmed.add(item.eventId)
    await saveState()
  }

  const finalizeStop = async () => {
    if (stopTimer) { clearTimeout(stopTimer); stopTimer = undefined }
    stoppingTurnId = undefined
    stopped = true
    await options.onStop?.()
    await options.client.postEvent(options.sessionId, eventFor({
      data: { status: "stopped" },
      source: "runner",
      type: "runner.status",
    }))
  }

  const dispatch = async (event: SessionStreamEvent) => {
    if (isTurnStarted(event)) {
      const items = await options.client.getItems(options.sessionId)
      const item = items.find(candidate => candidate.turnId === event.turnId)
      if (item) await dispatchItem(item)
      return
    }
    // 等待 Codex 终态事件以确认中断结果，而非冒进地上报 turn.interrupted
    if (stoppingTurnId && event.turnId === stoppingTurnId &&
        (event.type === "turn.interrupted" || event.type === "turn.failed" || event.type === "turn.completed")) {
      await finalizeStop()
      return
    }
    if (event.type === "session.interrupt") {
      const turnId = typeof event.data?.turnId === "string" ? event.data.turnId : undefined
      if (turnId && !interrupted.has(turnId)) {
        interrupted.add(turnId)
        await options.onInterrupt?.(turnId)
      }
      return
    }
    if (event.type === "session.stop") {
      const turnId = typeof event.data?.turnId === "string" ? event.data.turnId : undefined
      if (turnId && !interrupted.has(turnId)) {
        interrupted.add(turnId)
        await options.onInterrupt?.(turnId).catch(() => undefined)
      }
      if (turnId) {
        // 不立即上报 turn.interrupted：等待 Codex 终态事件确认
        stoppingTurnId = turnId
        // 超时保护：无论上报成功与否都必须清理本地资源
        stopTimer = setTimeout(() => {
          void (async () => {
            try {
              await options.client.postEvent(options.sessionId, eventFor({
                data: { reason: "Interrupt timeout - no terminal event from Codex", turnId },
                source: "runner",
                type: "turn.failed",
              }))
            } catch {
              // Session API 不可用不影响本地资源清理
            }
            await finalizeStop()
          })()
        }, 30_000)
        return
      }
      // 无活跃 turnId：直接完成停止
      await finalizeStop()
    }
  }

  const consumeOnce = async () => {
    await loadState()
    // SSE is live-tail only; scan persisted input items so a reconnect cannot miss a turn.started event.
    for (const item of await options.client.getItems(options.sessionId)) await dispatchItem(item)
    activeIterator = options.client.stream(options.sessionId)[Symbol.asyncIterator]()
    try {
      while (!stopped) {
        const next = await activeIterator.next()
        if (next.done) return
        await dispatch(next.value)
      }
    } finally {
      await activeIterator.return?.()
      activeIterator = undefined
    }
  }

  const run = async () => {
    await register()
    try {
      while (!stopped) await consumeOnce()
    } catch (error) {
      if (!stopped) {
        await options.client.postEvent(options.sessionId, eventFor({
          data: { status: "failed" },
          source: "runner",
          type: "runner.status",
        }))
      }
      throw error
    }
  }

  return {
    consumeOnce,
    run,
    stop: () => {
      stopped = true
      if (stopTimer) { clearTimeout(stopTimer); stopTimer = undefined }
      // 外部强制停止时释放 pending 状态，防止泄漏
      stoppingTurnId = undefined
      void activeIterator?.return?.()
    },
  }
}

export type { SessionItem }
