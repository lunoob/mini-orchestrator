import { randomUUID } from "node:crypto"

import { applySessionEvent } from "./events.js"
import type {
  CompleteTurnInput,
  CreateSessionInput,
  SessionEventAck,
  SessionInputEvent,
  SessionItem,
  SessionRecord,
  SessionStreamEvent,
  SubmitMessageInput,
  SubmitMessageResult,
  Turn,
} from "./types.js"

export type SessionStore = {
  applyEvent: (input: { event: SessionInputEvent; sessionId: string }) => SessionEventAck
  completeTurn: (input: CompleteTurnInput) => void
  create: (input: CreateSessionInput) => SessionRecord
  get: (sessionId: string) => SessionRecord | undefined
  getItems: (sessionId: string) => SessionItem[]
  getRunnerToken: (sessionId: string) => string | undefined
  getTurn: (sessionId: string, turnId: string) => Turn | undefined
  markReady: (sessionId: string) => void
  snapshot: () => SessionStoreSnapshot
  submitMessage: (input: SubmitMessageInput) => SubmitMessageResult
  subscribe: (sessionId: string, listener: (event: SessionStreamEvent) => void) => () => void
}

export type SessionStoreSnapshot = {
  items: Record<string, SessionItem[]>
  runnerTokens?: Record<string, string>
  sequence: number
  sessions: SessionRecord[]
  submittedEvents: Array<{ key: string; result: SubmitMessageResult }>
  turns?: Record<string, Turn[]>
}

type StoreOptions = {
  createId?: () => string
  now?: () => Date
  snapshot?: SessionStoreSnapshot
}

const terminalStatuses = new Set(["completed", "failed", "interrupted"])

export const createSessionStore = (options: StoreOptions = {}): SessionStore => {
  const createId = options.createId ?? randomUUID
  const now = options.now ?? (() => new Date())
  const sessions = new Map(
    (options.snapshot?.sessions ?? []).map(session => [session.id, { ...session }]),
  )
  const items = new Map(
    Object.entries(options.snapshot?.items ?? {}).map(([id, savedItems]) => [id, [...savedItems]]),
  )
  const turns = new Map(
    Object.entries(options.snapshot?.turns ?? {}).map(([id, savedTurns]) => [id, [...savedTurns]]),
  )
  const submittedEvents = new Map(
    (options.snapshot?.submittedEvents ?? []).map(({ key, result }) => [key, { ...result }]),
  )
  const runnerTokens = new Map(Object.entries(options.snapshot?.runnerTokens ?? {}))
  const subscribers = new Map<string, Set<(event: SessionStreamEvent) => void>>()
  let sequence = options.snapshot?.sequence ?? 0

  const get = (sessionId: string) => {
    const session = sessions.get(sessionId)
    if (!session) return
    return { ...session, turns: [...(turns.get(sessionId) ?? session.turns ?? [])] }
  }

  const requireSession = (sessionId: string) => {
    const session = get(sessionId)
    if (session) return session
    throw new Error(`[Session] Unknown session: ${sessionId}`)
  }

  const save = (session: SessionRecord) => {
    const { turns: sessionTurns, ...record } = session
    sessions.set(session.id, record as SessionRecord)
    turns.set(session.id, [...sessionTurns])
  }

  const publish = (
    sessionId: string,
    event: Omit<SessionStreamEvent, "sequence" | "sessionId">,
  ) => {
    sequence += 1
    const streamedEvent: SessionStreamEvent = { ...event, sequence, sessionId }
    for (const listener of subscribers.get(sessionId) ?? []) listener(streamedEvent)
  }

  const publishStatus = (session: SessionRecord) =>
    publish(session.id, { status: session.status, type: "session.status" })

  const getTurns = (sessionId: string) => [...(turns.get(sessionId) ?? [])]

  const activeTurn = (sessionId: string) =>
    getTurns(sessionId).find(turn => !terminalStatuses.has(turn.status))

  const statusFor = (session: SessionRecord, nextTurns: Turn[]): SessionRecord["status"] => {
    if (session.status === "stopped") return "stopped"
    if (nextTurns.some(turn => !terminalStatuses.has(turn.status))) return "running"
    if (session.status === "failed") return "failed"
    if (session.runnerReady) return "ready"
    return "starting"
  }

  const updateSession = (session: SessionRecord, nextTurns = getTurns(session.id)) => {
    const active = nextTurns.find(turn => !terminalStatuses.has(turn.status))
    const updated: SessionRecord = {
      ...session,
      activeTurnId: active?.id,
      status: statusFor(session, nextTurns),
      turns: nextTurns,
    }
    save(updated)
    return updated
  }

  const addItem = (sessionId: string, item: SessionItem) => {
    const current = items.get(sessionId) ?? []
    if (current.some(existing => existing.id === item.id)) return false
    items.set(sessionId, [...current, item])
    return true
  }

  const create = (input: CreateSessionInput): SessionRecord => {
    const session: SessionRecord = {
      agent: input.agent,
      createdAt: now().toISOString(),
      id: input.id ?? createId(),
      role: input.role,
      runnerReady: false,
      runnerStatus: "starting",
      runDirectory: input.runDirectory,
      status: "starting",
      turns: [],
      workspace: input.workspace,
    }
    save(session)
    items.set(session.id, [])
    runnerTokens.set(session.id, randomUUID())
    return session
  }

  const getItems = (sessionId: string) => [...(items.get(sessionId) ?? [])]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const getRunnerToken = (sessionId: string) => runnerTokens.get(sessionId)
  const getTurn = (sessionId: string, turnId: string) =>
    getTurns(sessionId).find(turn => turn.id === turnId)

  const subscribe = (sessionId: string, listener: (event: SessionStreamEvent) => void) => {
    const sessionSubscribers = subscribers.get(sessionId) ?? new Set()
    sessionSubscribers.add(listener)
    subscribers.set(sessionId, sessionSubscribers)
    publish(sessionId, { type: "session.heartbeat" })
    return () => {
      sessionSubscribers.delete(listener)
      if (sessionSubscribers.size === 0) subscribers.delete(sessionId)
    }
  }

  const markReady = (sessionId: string) => {
    const session = requireSession(sessionId)
    const updated = updateSession({ ...session, runnerReady: true, runnerStatus: "ready" })
    publish(sessionId, { type: "runner.ready" })
    publishStatus(updated)
  }

  const submitMessage = (input: SubmitMessageInput): SubmitMessageResult => {
    const session = requireSession(input.sessionId)
    const eventKey = `${input.sessionId}:${input.eventId}`
    const previous = submittedEvents.get(eventKey)
    if (previous) return previous

    const turn: Turn = {
      createdAt: now().toISOString(),
      id: createId(),
      sessionId: input.sessionId,
      status: "running",
    }
    const result: SubmitMessageResult = { queued: true, turnId: turn.id }
    const item: SessionItem = {
      content: input.content,
      createdAt: turn.createdAt,
      eventId: input.eventId,
      id: `item-${randomUUID()}`,
      role: "user",
      turnId: turn.id,
    }

    // eventId is the retry boundary: prompt text is not a safe idempotency key.
    submittedEvents.set(eventKey, result)
    addItem(input.sessionId, item)
    const updated = updateSession(session, [...getTurns(input.sessionId), turn])
    publishStatus(updated)
    publish(input.sessionId, { turnId: turn.id, type: "turn.started" })
    return result
  }

  const finishTurn = (
    sessionId: string,
    turnId: string,
    status: Turn["status"],
    content?: string,
    error?: string,
    outputEventType: "output_item.done" | "response.output_item.done" = "output_item.done",
  ) => {
    const session = requireSession(sessionId)
    const currentTurns = getTurns(sessionId)
    const current = currentTurns.find(turn => turn.id === turnId)
    if (!current) throw new Error(`[Session] Unknown turn: ${turnId}`)
    if (terminalStatuses.has(current.status)) return current

    const completedAt = now().toISOString()
    const finished: Turn = { ...current, completedAt, error, status }
    if (content !== undefined) finished.outputText = content
    const nextTurns = currentTurns.map(turn => turn.id === turnId ? finished : turn)
    const updated = updateSession(
      status === "failed"
        ? { ...session, lastError: error ?? "Turn failed", status: "failed" }
        : session,
      nextTurns,
    )
    if (content !== undefined && !getItems(sessionId).some(item => item.role === "assistant" && item.turnId === turnId)) {
      addItem(sessionId, {
        content,
        createdAt: completedAt,
        id: `item-${createId()}`,
        role: "assistant",
        turnId,
      })
      publish(sessionId, { data: { content }, turnId, type: outputEventType })
    }
    publish(sessionId, { data: error ? { error } : undefined, turnId, type: `turn.${status}` as SessionStreamEvent["type"] })
    publishStatus(updated)
    return finished
  }

  const applyEvent = (input: { event: SessionInputEvent; sessionId: string }) => applySessionEvent({
    activeTurn,
    addItem,
    finishTurn,
    getTurn,
    getTurns,
    publish,
    requireSession,
    submitMessage,
    now,
    updateSession,
  }, input)

  const completeTurn = (input: CompleteTurnInput) => {
    applyEvent({
      event: { data: { content: input.content, turnId: input.turnId }, type: "turn.completed" },
      sessionId: input.sessionId,
    })
  }

  const snapshot = (): SessionStoreSnapshot => ({
    items: Object.fromEntries([...items.entries()].map(([id, savedItems]) => [id, [...savedItems]])),
    runnerTokens: Object.fromEntries(runnerTokens),
    sequence,
    sessions: [...sessions.values()].map(session => ({ ...session, turns: [] })),
    submittedEvents: [...submittedEvents.entries()].map(([key, result]) => ({ key, result: { ...result } })),
    turns: Object.fromEntries([...turns.entries()].map(([id, savedTurns]) => [id, [...savedTurns]])),
  })

  return {
    applyEvent,
    completeTurn,
    create,
    get,
    getItems,
    getRunnerToken,
    getTurn,
    markReady,
    snapshot,
    submitMessage,
    subscribe,
  }
}
