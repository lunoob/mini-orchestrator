import type {
  CreateSessionInput,
  SessionInputEvent,
  SessionItem,
  SessionRecord,
  SessionStreamEvent,
  SubmitMessageResult,
} from "./types.js"
import { waitForTurn as waitForTurnResult } from "./turn-wait.js"

export type SessionClient = {
  create: (input: Omit<CreateSessionInput, "id">) => Promise<SessionRecord>
  get: (sessionId: string) => Promise<SessionRecord>
  getItems: (sessionId: string) => Promise<SessionItem[]>
  getRunnerToken: (sessionId: string) => string | undefined
  postEvent: (sessionId: string, event: SessionInputEvent) => Promise<unknown>
  sendMessage: (
    sessionId: string,
    input: { content: string; eventId: string },
  ) => Promise<SubmitMessageResult>
  stream: (sessionId: string) => AsyncIterable<SessionStreamEvent>
  waitForTurn: (sessionId: string, turnId: string) => Promise<SessionItem>
}

type ClientOptions = {
  baseUrl: string
  token: string
  runnerToken?: string
}

const readJson = async (response: Response) => {
  const body = await response.json() as unknown
  if (response.ok) return body

  const message = typeof body === "object" && body !== null && "error" in body
    ? String(body.error)
    : `Session API request failed with status ${response.status}`
  throw new Error(`[Session] ${message}`)
}

const parseSse = async function* (response: Response): AsyncIterable<SessionStreamEvent> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error("[Session] SSE response has no body")

  const decoder = new TextDecoder()
  let buffer = ""

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return
      buffer += decoder.decode(value, { stream: true })

      const frames = buffer.split("\n\n")
      buffer = frames.pop() ?? ""
      for (const frame of frames) {
        const payload = frame.split("\n").find(line => line.startsWith("data: "))
        if (payload) yield JSON.parse(payload.slice(6)) as SessionStreamEvent
      }
    }
  } finally {
    await reader.cancel()
  }
}

export const createSessionClient = (options: ClientOptions): SessionClient => {
  const headers = {
    authorization: `Bearer ${options.token}`,
    "content-type": "application/json",
  }
  const runnerTokens = new Map<string, string>()

  const isRunnerEvent = (event: SessionInputEvent) =>
    event.type === "ready" || event.type === "status" || event.type.startsWith("runner.") || event.type.startsWith("output_") || event.type.startsWith("turn.")

  const request = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(`${options.baseUrl}${path}`, {
      ...init,
      headers: { ...headers, ...init.headers },
    })
    return readJson(response)
  }

  const create = async (input: Omit<CreateSessionInput, "id">) => {
    const body = await request("/v1/sessions", {
      body: JSON.stringify(input),
      method: "POST",
    }) as { runnerToken?: string; session: SessionRecord }
    if (body.runnerToken) runnerTokens.set(body.session.id, body.runnerToken)
    return body.session
  }

  const get = async (sessionId: string) => {
    const body = await request(`/v1/sessions/${sessionId}`) as { session: SessionRecord }
    return body.session
  }

  const getItems = async (sessionId: string) => {
    const body = await request(`/v1/sessions/${sessionId}/items`) as { items: SessionItem[] }
    return body.items
  }

  const postEvent = (sessionId: string, event: SessionInputEvent) => {
    const runnerToken = options.runnerToken ?? runnerTokens.get(sessionId)
    const eventHeaders = isRunnerEvent(event) && runnerToken
      ? { authorization: `Bearer ${runnerToken}` }
      : undefined
    return request(`/v1/sessions/${sessionId}/events`, {
      body: JSON.stringify(event),
      headers: eventHeaders,
      method: "POST",
    })
  }

  const sendMessage = async (
    sessionId: string,
    input: { content: string; eventId: string },
  ) => postEvent(sessionId, {
    data: { content: input.content },
    eventId: input.eventId,
    type: "message",
  }) as Promise<SubmitMessageResult>

  const stream = async function* (sessionId: string): AsyncIterable<SessionStreamEvent> {
    const response = await fetch(`${options.baseUrl}/v1/sessions/${sessionId}/stream`, { headers })
    if (!response.ok) {
      await readJson(response)
      return
    }
    yield* parseSse(response)
  }

  const waitForTurn = async (sessionId: string, turnId: string): Promise<SessionItem> => {
    const waited = await waitForTurnResult({ create, get, getItems, getRunnerToken: sessionId => runnerTokens.get(sessionId), postEvent, sendMessage, stream, waitForTurn }, sessionId, turnId)
    if (waited.turn.status !== "completed") {
      throw new Error(`[Session] Turn ${turnId} ended with status ${waited.turn.status}${waited.turn.error ? `: ${waited.turn.error}` : ""}`)
    }
    if (waited.output) return waited.output
    throw new Error(`[Session] Turn ${turnId} ended with status ${waited.turn.status}${waited.turn.error ? `: ${waited.turn.error}` : ""}`)
  }

  return { create, get, getItems, getRunnerToken: sessionId => runnerTokens.get(sessionId), postEvent, sendMessage, stream, waitForTurn }
}
