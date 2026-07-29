import { readFile, writeFile } from "node:fs/promises"

import type { SessionClient } from "./client.js"
import type { RunnerStatus, SessionInputEvent, SessionItem, SessionStreamEvent } from "./types.js"

export type RunnerMessage = { content: string; eventId: string; turnId: string }

export type RunnerClient = {
  consumeOnce: () => Promise<void>
  /** Resolves when all queued interaction prompts have completed */
  drainInteractions: () => Promise<void>
  /** Get the current controllerId (undefined if not yet registered) */
  getControllerId: () => string | undefined
  /** Post a runner event with controllerId attached. Use this for ALL runner events. */
  postRunnerEvent: (event: SessionInputEvent) => Promise<unknown>
  /**
   * Report terminal status (stopped/failed) with controllerId.
   * Use this instead of posting runner.status directly to ensure lease release.
   */
  reportTerminalStatus: (status: "stopped" | "failed", reason?: string) => Promise<void>
  run: () => Promise<void>
  stop: () => void
}

export type InteractionRequest = {
  interactionId: string
  request: import("../workflow/agent-outcome.js").InputRequest
  role: import("./types.js").SessionRole
  turnId?: string
}

export type InteractionResult = { optionId?: string; text?: string } | null

type RunnerClientOptions = {
  client: Pick<SessionClient, "getInteractions" | "getItems" | "postEvent" | "stream">
  onInterrupt?: (turnId: string) => Promise<void>
  onInteraction?: (request: InteractionRequest) => Promise<InteractionResult>
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
  const processedInteractions = new Set<string>() // already handled or in-flight
  let stopped = false
  let loaded = false
  let controllerId: string | undefined // received from server on runner.ready
  let controllerHeartbeatTimer: ReturnType<typeof setInterval> | undefined
  // 等待 Codex 终态事件期间的状态
  let stoppingTurnId: string | undefined
  let stopTimer: ReturnType<typeof setTimeout> | undefined
  let activeIterator: AsyncIterator<SessionStreamEvent> | undefined
  // Serialize interaction prompts — only one can read stdin at a time
  let interactionQueue: Promise<void> = Promise.resolve()
  const CONTROLLER_HEARTBEAT_INTERVAL_MS = 15_000 // well under 60s TTL

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

  const runnerEvent = (event: SessionInputEvent): SessionInputEvent => {
    if (controllerId && typeof event === "object") {
      return { ...event, controllerId } as SessionInputEvent
    }
    return event
  }

  const startControllerHeartbeat = () => {
    if (controllerHeartbeatTimer) return
    controllerHeartbeatTimer = setInterval(() => {
      if (stopped || !controllerId) return
      void options.client.postEvent(options.sessionId, runnerEvent({
        data: { status: "idle" as RunnerStatus },
        source: "runner",
        type: "runner.status",
      } as SessionInputEvent)).catch(() => {})
    }, CONTROLLER_HEARTBEAT_INTERVAL_MS)
  }

  const stopControllerHeartbeat = () => {
    if (controllerHeartbeatTimer) {
      clearInterval(controllerHeartbeatTimer)
      controllerHeartbeatTimer = undefined
    }
  }

  const register = async () => {
    const result = await options.client.postEvent(
      options.sessionId,
      eventFor({ source: "runner", type: "runner.ready" }),
    ) as { controllerId?: string } | undefined
    if (result?.controllerId) {
      controllerId = result.controllerId
      startControllerHeartbeat()
    }
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
    stopControllerHeartbeat()
    await options.onStop?.()
    await options.client.postEvent(options.sessionId, runnerEvent({
      data: { status: "stopped" },
      source: "runner",
      type: "runner.status",
    } as SessionInputEvent))
  }

  const handleInteraction = async (event: SessionStreamEvent) => {
    if (event.type !== "interaction.request" || !event.data || !options.onInteraction) return
    const { interactionId, request, role, turnId } = event.data as {
      interactionId: string
      request: import("../workflow/agent-outcome.js").InputRequest
      role: import("./types.js").SessionRole
      turnId?: string
    }
    // Dedup: skip already-processed or in-flight interactions
    if (processedInteractions.has(interactionId)) return
    // Mark as in-flight (will be removed on failure so reconnect can retry)
    processedInteractions.add(interactionId)
    // Serialize: queue behind any running interaction
    const prev = interactionQueue
    let resolveQueue!: () => void
    interactionQueue = new Promise<void>(r => { resolveQueue = r })
    await prev

    try {
      const result = await options.onInteraction({ interactionId, request, role, turnId })
      if (result) {
        await options.client.postEvent(options.sessionId, runnerEvent({
          data: { interactionId, ...result },
          type: "interaction.response",
        } as SessionInputEvent))
      } else {
        await options.client.postEvent(options.sessionId, runnerEvent({
          data: { interactionId },
          type: "interaction.cancel",
        } as SessionInputEvent))
      }
      // Keep the dedup mark — response/cancel was successfully persisted
    } catch (error) {
      // Remove the dedup mark so reconnect can retry this pending interaction
      processedInteractions.delete(interactionId)
      throw error
    } finally {
      resolveQueue()
    }
  }

  const dispatch = async (event: SessionStreamEvent) => {
    // Pick up controllerId from server SSE event
    if (event.type === "runner.controller" && event.controllerId) {
      controllerId = event.controllerId
      startControllerHeartbeat()
      return
    }
    if (event.type === "interaction.request") {
      // Fire and forget — serialized via interactionQueue; errors handled internally
      void handleInteraction(event).catch(() => {})
      return
    }
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
              await postRunnerEvent({
                data: { reason: "Interrupt timeout - no terminal event from Codex", turnId },
                source: "runner",
                type: "turn.failed",
              } as SessionInputEvent)
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
    // Establish SSE subscription and wait for the first event (heartbeat) to confirm it's live.
    // Only after the SSE is confirmed live do we read pending interactions — this closes the gap
    // between reading persisted state and the SSE connection actually being established.
    activeIterator = options.client.stream(options.sessionId)[Symbol.asyncIterator]()
    const first = await activeIterator.next()
    // Now read and dispatch pending interactions. Any new interaction created after this point
    // will arrive via the already-established SSE subscription.
    if (options.onInteraction) {
      for (const interaction of await options.client.getInteractions(options.sessionId)) {
        if (interaction.status === "pending" && !processedInteractions.has(interaction.interactionId)) {
          void handleInteraction({
            data: {
              interactionId: interaction.interactionId,
              request: interaction.request,
              role: interaction.role,
              turnId: interaction.turnId,
            },
            sequence: 0,
            sessionId: options.sessionId,
            type: "interaction.request",
          }).catch(() => {})
        }
      }
    }
    try {
      // Dispatch the first event we already read, then continue with the rest of the stream.
      if (!first.done) await dispatch(first.value)
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
        stopControllerHeartbeat()
        await options.client.postEvent(options.sessionId, runnerEvent({
          data: { status: "failed" },
          source: "runner",
          type: "runner.status",
        } as SessionInputEvent))
      }
      throw error
    }
  }

  const postRunnerEvent = (event: SessionInputEvent) =>
    options.client.postEvent(options.sessionId, runnerEvent(event))

  const reportTerminalStatus = async (status: "stopped" | "failed", reason?: string) => {
    stopControllerHeartbeat()
    await postRunnerEvent({
      data: reason ? { reason, status } : { status },
      source: "runner",
      type: "runner.status",
    } as SessionInputEvent).catch(() => {})
  }

  return {
    consumeOnce,
    drainInteractions: () => interactionQueue,
    getControllerId: () => controllerId,
    postRunnerEvent,
    reportTerminalStatus,
    run,
    stop: () => {
      stopped = true
      stopControllerHeartbeat()
      if (stopTimer) { clearTimeout(stopTimer); stopTimer = undefined }
      stoppingTurnId = undefined
      void activeIterator?.return?.()
    },
  }
}

export type { SessionItem }
