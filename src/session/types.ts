import type { AgentConfig } from "../types.js"

export type SessionStatus = "starting" | "ready" | "running" | "waiting" | "idle" | "stopping" | "failed" | "stopped"
export type SessionRole = "implementer" | "reviewer"
export type SessionAgent = AgentConfig
export type RunnerStatus = "starting" | "ready" | "working" | "idle" | "stopping" | "failed" | "stopped"
export type TurnStatus = "queued" | "running" | "completed" | "failed" | "interrupted"

export type Turn = {
  createdAt: string
  error?: string
  id: string
  outputText?: string
  sessionId: string
  status: TurnStatus
  completedAt?: string
}

export type SessionRecord = {
  activeTurnId?: string
  agent: SessionAgent
  createdAt: string
  id: string
  lastError?: string
  role: SessionRole
  runnerReady: boolean
  runnerStatus: RunnerStatus
  runDirectory: string
  status: SessionStatus
  turns: Turn[]
  workspace: string
}

export type Session = SessionRecord

export type RunnerRegistration = {
  id: string
  ready: boolean
  sessionId: string
  status: RunnerStatus
}

export type RunnerEvent = Exclude<SessionInputEvent, { type: "message" | "interrupt" | "stop" }>

export type CreateSessionInput = {
  agent: SessionAgent
  id?: string
  role: SessionRole
  runDirectory: string
  workspace: string
}

export type ConversationItem = {
  content: string
  createdAt: string
  eventId?: string
  id: string
  role: "assistant" | "user"
  sequence?: number
  turnId: string
}

export type SessionItem = ConversationItem

export type SubmitMessageInput = {
  content: string
  eventId: string
  sessionId: string
}

export type SubmitMessageResult = {
  eventId?: string
  queued: true
  turnId: string
}

type TurnEventData = { turnId: string }

export type SessionInputEvent =
  | { data: { content: string }; eventId: string; type: "message" }
  | { data?: { turnId?: string }; eventId?: string; type: "interrupt" }
  | { data?: { turnId?: string }; eventId?: string; type: "stop" }
  | { source?: "runner"; type: "ready" | "runner.ready" }
  | { data: { status: RunnerStatus }; source?: "runner"; type: "runner.status" | "status" }
  | { data: { reason: string }; eventId?: string; type: "runner.failure" }
  | { data: { delta: string } & TurnEventData; source?: "runner"; type: "output_text.delta" | "runner.output_text.delta" }
  | { data: { content: string } & TurnEventData; source?: "runner"; type: "output_item.done" | "runner.output_item.done" }
  | { data: TurnEventData & { content?: string }; source?: "runner"; type: "turn.completed" }
  | { data: TurnEventData & { reason?: string }; source?: "runner"; type: "turn.failed" }
  | { data: TurnEventData; source?: "runner"; type: "turn.interrupted" }
  | { data: { content?: string } & TurnEventData; source?: "runner"; type: "runner.turn.completed" }

export type SessionEventAck = {
  eventId?: string
  queued: boolean
  turnId?: string
}

export type SessionStreamEvent = {
  data?: Record<string, unknown>
  eventId?: string
  sequence: number
  sessionId: string
  status?: SessionStatus
  turnId?: string
  type:
    | "output_item.done"
    | "output_text.delta"
    | "response.output_item.done"
    | "session.heartbeat"
    | "session.status"
    | "runner.ready"
    | "runner.status"
    | "session.interrupt"
    | "session.stop"
    | "turn.completed"
    | "turn.failed"
    | "turn.interrupted"
    | "turn.started"
}

export type CompleteTurnInput = {
  content: string
  sessionId: string
  turnId: string
}

export type TurnWaitResult = {
  output?: SessionItem
  turn: Turn
}
