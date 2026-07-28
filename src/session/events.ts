import type {
  SessionEventAck,
  SessionInputEvent,
  SessionItem,
  SessionRecord,
  SessionStreamEvent,
  SubmitMessageResult,
  Turn,
} from "./types.js"

type EventDeps = {
  addItem: (sessionId: string, item: SessionItem) => boolean
  activeTurn: (sessionId: string) => Turn | undefined
  finishTurn: (
    sessionId: string,
    turnId: string,
    status: Turn["status"],
    content?: string,
    error?: string,
    outputEventType?: "output_item.done" | "response.output_item.done",
  ) => Turn
  getTurn: (sessionId: string, turnId: string) => Turn | undefined
  getTurns: (sessionId: string) => Turn[]
  publish: (sessionId: string, event: Omit<SessionStreamEvent, "sequence" | "sessionId">) => void
  requireSession: (sessionId: string) => SessionRecord
  submitMessage: (input: { content: string; eventId: string; sessionId: string }) => SubmitMessageResult
  now: () => Date
  updateSession: (session: SessionRecord, nextTurns?: Turn[]) => SessionRecord
}

const terminalStatuses = new Set(["completed", "failed", "interrupted"])

export const applySessionEvent = (
  deps: EventDeps,
  { event, sessionId }: { event: SessionInputEvent; sessionId: string },
): SessionEventAck => {
  deps.requireSession(sessionId)

  if (event.type === "message") {
    return { ...deps.submitMessage({ content: event.data.content, eventId: event.eventId, sessionId }), eventId: event.eventId }
  }
  if (event.type === "runner.failure") {
    const active = deps.activeTurn(sessionId)
    if (active) deps.finishTurn(sessionId, active.id, "failed", undefined, event.data.reason)
    const updated = deps.updateSession({
      ...deps.requireSession(sessionId),
      lastError: event.data.reason,
      runnerStatus: "failed",
      status: "failed",
    })
    deps.publish(sessionId, { data: { reason: event.data.reason, status: "failed" }, type: "runner.status" })
    deps.publish(sessionId, { status: updated.status, type: "session.status" })
    return { eventId: event.eventId, queued: false }
  }
  if (event.type === "runner.ready" || event.type === "ready") {
    const session = deps.requireSession(sessionId)
    const updated = deps.updateSession({ ...session, runnerReady: true, runnerStatus: "ready" })
    deps.publish(sessionId, { type: "runner.ready" })
    deps.publish(sessionId, { status: updated.status, type: "session.status" })
    return { queued: false }
  }
  if (event.type === "runner.status" || event.type === "status") {
    const session = deps.requireSession(sessionId)
    if (event.data.status === "failed") {
      const active = deps.activeTurn(sessionId)
      if (active) deps.finishTurn(sessionId, active.id, "failed", undefined, "Runner failed")
    } else if (event.data.status === "stopped") {
      const active = deps.activeTurn(sessionId)
      if (active) deps.finishTurn(sessionId, active.id, "interrupted", undefined, "Runner stopped")
    }
    const current = deps.requireSession(sessionId)
    const updated = deps.updateSession({
      ...current,
      runnerReady: event.data.status === "ready" || event.data.status === "idle",
      runnerStatus: event.data.status,
      status: event.data.status === "failed"
        ? "failed"
        : event.data.status === "stopped" ? "stopped" : current.status,
    })
    deps.publish(sessionId, { data: { status: event.data.status }, type: "runner.status" })
    deps.publish(sessionId, { status: updated.status, type: "session.status" })
    return { queued: false }
  }
  if (event.type === "output_text.delta" || event.type === "runner.output_text.delta") {
    const turn = deps.getTurn(sessionId, event.data.turnId)
    if (!turn || terminalStatuses.has(turn.status)) throw new Error(`[Session] Turn is not active: ${event.data.turnId}`)
    const nextTurns = deps.getTurns(sessionId).map(current => current.id === turn.id
      ? { ...current, outputText: `${current.outputText ?? ""}${event.data.delta}` }
      : current)
    const updated = deps.updateSession(deps.requireSession(sessionId), nextTurns)
    deps.publish(sessionId, { data: { delta: event.data.delta }, turnId: turn.id, type: "output_text.delta" })
    deps.publish(sessionId, { status: updated.status, type: "session.status" })
    return { queued: false, turnId: turn.id }
  }
  if (event.type === "output_item.done" || event.type === "runner.output_item.done") {
    const turn = deps.getTurn(sessionId, event.data.turnId)
    if (!turn) throw new Error(`[Session] Unknown turn: ${event.data.turnId}`)
    deps.addItem(sessionId, {
      content: event.data.content,
      createdAt: deps.now().toISOString(),
      id: `item-${turn.id}`,
      role: "assistant",
      turnId: turn.id,
    })
    deps.publish(sessionId, { data: { content: event.data.content }, turnId: turn.id, type: "output_item.done" })
    return { queued: false, turnId: turn.id }
  }
  if (event.type === "turn.completed" || event.type === "runner.turn.completed") {
    const content = event.data.content ?? deps.getTurn(sessionId, event.data.turnId)?.outputText
    deps.finishTurn(
      sessionId,
      event.data.turnId,
      "completed",
      content,
      undefined,
      event.type === "runner.turn.completed" ? "response.output_item.done" : undefined,
    )
    return { queued: false, turnId: event.data.turnId }
  }
  if (event.type === "turn.failed") {
    deps.finishTurn(sessionId, event.data.turnId, "failed", undefined, event.data.reason)
    return { queued: false, turnId: event.data.turnId }
  }
  if (event.type === "turn.interrupted") {
    deps.finishTurn(sessionId, event.data.turnId, "interrupted")
    return { queued: false, turnId: event.data.turnId }
  }
  if (event.type === "interrupt") {
    const turn = event.data?.turnId ? deps.getTurn(sessionId, event.data.turnId) : deps.activeTurn(sessionId)
    // Interrupt is a runner instruction; only the matching terminal event may finish the turn.
    deps.publish(sessionId, { data: turn ? { turnId: turn.id } : undefined, type: "session.interrupt" })
    return { eventId: event.eventId, queued: false, turnId: turn?.id }
  }

  if (event.type === "stop") {
    const session = deps.requireSession(sessionId)
    // Stopping first blocks new messages; the runner publishes stopped only after interrupt/exit.
    const updated = deps.updateSession({ ...session, runnerStatus: "stopping", status: "stopping" })
    const active = deps.activeTurn(sessionId)
    deps.publish(sessionId, { data: active ? { turnId: active.id } : undefined, type: "session.stop" })
    deps.publish(sessionId, { status: updated.status, type: "session.status" })
    return { eventId: event.eventId, queued: false }
  }

  throw new Error("[Session] Unsupported session event")
}
