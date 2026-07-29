import { randomUUID } from "node:crypto"

import { applySessionEvent } from "./events.js"
import type {
  CompleteTurnInput,
  CreateSessionInput,
  InteractionRecord,
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
  cancelInteraction: (sessionId: string, interactionId: string) => void
  completeTurn: (input: CompleteTurnInput) => void
  create: (input: CreateSessionInput) => SessionRecord
  createInteraction: (input: { interactionId: string; sessionId: string; turnId?: string; role: InteractionRecord["role"]; request: InteractionRecord["request"] }) => InteractionRecord
  get: (sessionId: string) => SessionRecord | undefined
  getInteractions: (sessionId: string) => InteractionRecord[]
  getInteraction: (sessionId: string, interactionId: string) => InteractionRecord | undefined
  getItems: (sessionId: string) => SessionItem[]
  getPendingInteraction: (sessionId: string) => InteractionRecord | undefined
  getRunnerToken: (sessionId: string) => string | undefined
  getTurn: (sessionId: string, turnId: string) => Turn | undefined
  markReady: (sessionId: string) => void
  /** Register a runner as the active controller. Throws if another controller is already active. */
  registerController: (sessionId: string, controllerId: string) => void
  /** Release the controller lease for a session. */
  releaseController: (sessionId: string, controllerId: string) => void
  /** Publish controllerId to session subscribers (runner picks it up via SSE). */
  publishControllerId: (sessionId: string, controllerId: string) => void
  /** Refresh the controller lease TTL. */
  refreshController: (sessionId: string, controllerId: string) => void
  respondInteraction: (sessionId: string, interactionId: string, response: { optionId?: string; text?: string }) => { optionId?: string; text?: string }
  snapshot: () => SessionStoreSnapshot
  submitMessage: (input: SubmitMessageInput) => SubmitMessageResult
  subscribe: (sessionId: string, listener: (event: SessionStreamEvent) => void) => () => void
}

export type SessionStoreSnapshot = {
  interactions?: Record<string, InteractionRecord[]>
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
  const interactions = new Map(
    Object.entries(options.snapshot?.interactions ?? {}).map(([id, saved]) => [id, [...saved]]),
  )
  const submittedEvents = new Map(
    (options.snapshot?.submittedEvents ?? []).map(({ key, result }) => [key, { ...result }]),
  )
  const runnerTokens = new Map(Object.entries(options.snapshot?.runnerTokens ?? {}))
  // Controller lease: sessionId → { controllerId, expiry }
  const activeControllers = new Map<string, { controllerId: string; expiry: number }>()
  const CONTROLLER_LEASE_TTL_MS = 60_000 // 60 seconds
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
    if (session.runnerStatus === "stopped" || session.status === "stopped") return "stopped"
    if (session.runnerStatus === "failed" || session.status === "failed") return "failed"
    if (session.runnerStatus === "stopping" || session.status === "stopping") return "stopping"
    // Preserve waiting status when a pending interaction exists
    if (getPendingInteraction(session.id)) return "waiting"
    if (nextTurns.some(turn => !terminalStatuses.has(turn.status))) return "running"
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

  const getInteractions = (sessionId: string) => [...(interactions.get(sessionId) ?? [])]

  const getInteraction = (sessionId: string, interactionId: string) =>
    getInteractions(sessionId).find(i => i.interactionId === interactionId)

  const getPendingInteraction = (sessionId: string) =>
    getInteractions(sessionId).find(i => i.status === "pending")

  const createInteraction = (input: {
    interactionId: string
    sessionId: string
    turnId?: string
    role: InteractionRecord["role"]
    request: InteractionRecord["request"]
  }): InteractionRecord => {
    const session = requireSession(input.sessionId)
    // Reject duplicate interactionId
    if (getInteraction(input.sessionId, input.interactionId)) {
      throw new Error(`[Session] Duplicate interactionId: ${input.interactionId}`)
    }
    const record: InteractionRecord = {
      createdAt: now().toISOString(),
      interactionId: input.interactionId,
      request: input.request,
      role: input.role,
      sessionId: input.sessionId,
      status: "pending",
      turnId: input.turnId,
    }
    const current = getInteractions(input.sessionId)
    interactions.set(input.sessionId, [...current, record])
    // Override session status to waiting
    const updated = updateSession({ ...session, status: "waiting" })
    publish(input.sessionId, {
      data: {
        interactionId: record.interactionId,
        request: record.request,
        role: record.role,
        turnId: record.turnId,
      },
      type: "interaction.request",
    })
    publishStatus(updated)
    return record
  }

  const respondInteraction = (
    sessionId: string,
    interactionId: string,
    response: { optionId?: string; text?: string },
  ): { optionId?: string; text?: string } => {
    const existing = getInteraction(sessionId, interactionId)
    if (!existing) throw new Error(`[Session] Unknown interaction: ${interactionId}`)
    // Idempotent: return first response for answered
    if (existing.status === "answered") return existing.response!
    // Explicit failure for cancelled
    if (existing.status === "cancelled") throw new Error(`[Session] Interaction already cancelled: ${interactionId}`)

    // Validate response against request
    const { request } = existing
    if (response.optionId !== undefined) {
      if (!request.options || !request.options.some(o => o.id === response.optionId)) {
        throw new Error(`[Session] Invalid optionId: ${response.optionId}`)
      }
    }
    if (response.text !== undefined) {
      if (!response.text.trim()) {
        throw new Error(`[Session] Response requires non-empty text`)
      }
      // Text is only allowed when allowFreeform is true
      if (!request.allowFreeform) {
        throw new Error(`[Session] Text response not allowed when allowFreeform is false`)
      }
    }
    // If neither optionId nor text provided, that's invalid
    if (response.optionId === undefined && response.text === undefined) {
      throw new Error(`[Session] Response must include optionId or text`)
    }

    const respondedAt = now().toISOString()
    const updatedRecord: InteractionRecord = {
      ...existing,
      respondedAt,
      response,
      status: "answered",
    }
    const current = getInteractions(sessionId)
    interactions.set(sessionId, current.map(i => i.interactionId === interactionId ? updatedRecord : i))
    // Restore session status
    const session = requireSession(sessionId)
    updateSession(session)
    publish(sessionId, {
      data: { interactionId, ...response },
      type: "interaction.response",
    })
    publishStatus(requireSession(sessionId))
    return response
  }

  const cancelInteraction = (sessionId: string, interactionId: string): void => {
    const existing = getInteraction(sessionId, interactionId)
    if (!existing) throw new Error(`[Session] Unknown interaction: ${interactionId}`)
    if (existing.status !== "pending") return

    const updatedRecord: InteractionRecord = {
      ...existing,
      respondedAt: now().toISOString(),
      status: "cancelled",
    }
    const current = getInteractions(sessionId)
    interactions.set(sessionId, current.map(i => i.interactionId === interactionId ? updatedRecord : i))
    const session = requireSession(sessionId)
    updateSession(session)
    publish(sessionId, {
      data: { interactionId },
      type: "interaction.cancel",
    })
    publishStatus(requireSession(sessionId))
  }

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

  const registerController = (sessionId: string, controllerId: string): void => {
    requireSession(sessionId)
    const existing = activeControllers.get(sessionId)
    if (existing) {
      // Expired lease is stale — allow override
      if (now().getTime() >= existing.expiry) {
        activeControllers.delete(sessionId)
      } else if (existing.controllerId !== controllerId) {
        throw new Error(`[Session] Session ${sessionId} already has an active controller`)
      }
    }
    activeControllers.set(sessionId, { controllerId, expiry: now().getTime() + CONTROLLER_LEASE_TTL_MS })
  }

  const releaseController = (sessionId: string, controllerId: string): void => {
    const existing = activeControllers.get(sessionId)
    if (existing && existing.controllerId === controllerId) {
      activeControllers.delete(sessionId)
    }
  }

  /** Refresh the controller lease TTL. Called by runner heartbeat/status events. */
  const refreshController = (sessionId: string, controllerId: string): void => {
    const existing = activeControllers.get(sessionId)
    if (existing && existing.controllerId === controllerId) {
      existing.expiry = now().getTime() + CONTROLLER_LEASE_TTL_MS
    }
  }

  const publishControllerId = (sessionId: string, controllerId: string): void => {
    publish(sessionId, { controllerId, type: "runner.controller" })
  }

  const submitMessage = (input: SubmitMessageInput): SubmitMessageResult => {
    const session = requireSession(input.sessionId)
    if (["failed", "stopping", "stopped"].includes(session.status)) {
      throw new Error(`[Session] Session is not accepting messages: ${session.status}`)
    }
    if (getPendingInteraction(input.sessionId)) {
      throw new Error(`[Session] Session is waiting for user interaction: ${input.sessionId}`)
    }
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
    cancelInteraction,
    createInteraction,
    finishTurn,
    getPendingInteraction,
    getTurn,
    getTurns,
    publish,
    requireSession,
    respondInteraction,
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
    interactions: Object.fromEntries([...interactions.entries()].map(([id, saved]) => [id, [...saved]])),
    items: Object.fromEntries([...items.entries()].map(([id, savedItems]) => [id, [...savedItems]])),
    runnerTokens: Object.fromEntries(runnerTokens),
    sequence,
    sessions: [...sessions.values()].map(session => ({ ...session, turns: [] })),
    submittedEvents: [...submittedEvents.entries()].map(([key, result]) => ({ key, result: { ...result } })),
    turns: Object.fromEntries([...turns.entries()].map(([id, savedTurns]) => [id, [...savedTurns]])),
  })

  return {
    applyEvent,
    cancelInteraction,
    completeTurn,
    create,
    createInteraction,
    get,
    getInteractions,
    getInteraction,
    getItems,
    getPendingInteraction,
    getRunnerToken,
    getTurn,
    markReady,
    publishControllerId,
    refreshController,
    registerController,
    releaseController,
    respondInteraction,
    snapshot,
    submitMessage,
    subscribe,
  }
}
