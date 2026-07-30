import type { AgentActivity } from "./activity.js"
import type { AgentConfig } from "../types.js"
import type { InputRequest } from "../workflow/agent-outcome.js"

export type SessionStatus = "starting" | "ready" | "running" | "waiting" | "idle" | "stopping" | "failed" | "stopped"
export type SessionRole = "implementer" | "reviewer"
export type SessionAgent = AgentConfig
export type RunnerStatus = "starting" | "ready" | "working" | "idle" | "stopping" | "failed" | "stopped"
export type TurnStatus = "queued" | "running" | "completed" | "failed" | "interrupted"
export type InteractionStatus = "pending" | "answered" | "cancelled"

export type Turn = {
  createdAt: string
  error?: string
  id: string
  outputText?: string
  sessionId: string
  status: TurnStatus
  completedAt?: string
}

export type InteractionRecord = {
  createdAt: string
  interactionId: string
  request: InputRequest
  respondedAt?: string
  response?: { optionId?: string; text?: string }
  role: SessionRole
  sessionId: string
  status: InteractionStatus
  turnId?: string
}

export type SessionRecord = {
  activeTurnId?: string
  agent: SessionAgent
  createdAt: string
  id: string
  interactions?: InteractionRecord[]
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

type WithControllerId = { controllerId?: string }

export type SessionInputEvent =
  | { data: { content: string }; eventId: string; type: "message" }
  | WithControllerId & { data?: { turnId?: string }; eventId?: string; type: "interrupt" }
  | WithControllerId & { data?: { turnId?: string }; eventId?: string; type: "stop" }
  | WithControllerId & { source?: "runner"; type: "ready" | "runner.ready" }
  | WithControllerId & { data: { status: RunnerStatus }; source?: "runner"; type: "runner.status" | "status" }
  | WithControllerId & { data: { reason: string }; eventId?: string; type: "runner.failure" }
  | WithControllerId & { data: { delta: string } & TurnEventData; source?: "runner"; type: "output_text.delta" | "runner.output_text.delta" }
  | WithControllerId & { data: { content: string } & TurnEventData; source?: "runner"; type: "output_item.done" | "runner.output_item.done" }
  | WithControllerId & { data: TurnEventData & { content?: string }; source?: "runner"; type: "turn.completed" }
  | WithControllerId & { data: TurnEventData & { reason?: string }; source?: "runner"; type: "turn.failed" }
  | WithControllerId & { data: TurnEventData; source?: "runner"; type: "turn.interrupted" }
  | WithControllerId & { data: { content?: string } & TurnEventData; source?: "runner"; type: "runner.turn.completed" }
  | WithControllerId & { data: { activity: AgentActivity } & TurnEventData; source?: "runner"; type: "activity" }
  | { data: { interactionId: string; request: InputRequest; role: SessionRole; turnId?: string }; type: "interaction.request" }
  | { data: { interactionId: string; optionId?: string; text?: string }; type: "interaction.response" }
  | { data: { interactionId: string }; type: "interaction.cancel" }

export type SessionEventAck = {
  eventId?: string
  queued: boolean
  turnId?: string
}

export type SessionStreamEvent = {
  controllerId?: string
  data?: Record<string, unknown>
  eventId?: string
  sequence: number
  sessionId: string
  status?: SessionStatus
  turnId?: string
  type:
    | "activity"
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
    | "interaction.request"
    | "interaction.response"
    | "interaction.cancel"
    | "runner.controller"
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
