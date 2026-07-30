import { randomUUID } from "node:crypto"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"

import { createSessionStore, type SessionStore } from "./store.js"
import { readSessionSnapshot, writeSessionSnapshot } from "./persist.js"
import type { AgentConfig } from "../types.js"
import type { SessionAgent, SessionInputEvent, SessionRole, SessionStreamEvent } from "./types.js"

export type SessionApiServer = {
  start: () => Promise<{ baseUrl: string; token: string }>
  stop: () => Promise<void>
}

type ServerOptions = {
  runDirectory: string
  store?: SessionStore
  token?: string
}

const readJson = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  const body = Buffer.concat(chunks).toString("utf8")
  if (!body) return {}
  return JSON.parse(body) as unknown
}

const sendJson = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" })
  response.end(JSON.stringify(body))
}

const sendSse = (response: ServerResponse, event: SessionStreamEvent) => {
  response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  // Flush immediately so SSE events are delivered without buffering
  if (typeof (response as any).flush === "function") (response as any).flush()
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const requiredString = (value: unknown, field: string) => {
  if (typeof value === "string" && value.trim()) return value
  throw new Error(`[Session] Missing required string: ${field}`)
}

const requiredRole = (value: unknown): SessionRole => {
  if (value === "implementer" || value === "reviewer") return value
  throw new Error("[Session] role must be implementer or reviewer")
}

const requiredAgent = (value: unknown): SessionAgent => {
  if (!isRecord(value)) throw new Error("[Session] agent must be a parsed AgentConfig")
  if (typeof value.agent !== "string" || typeof value.name !== "string" || typeof value.command !== "string") {
    throw new Error("[Session] agent must include agent, name and command")
  }
  return value as unknown as AgentConfig
}

const pathSessionId = (pathname: string, suffix = "") => {
  const match = pathname.match(new RegExp(`^/v1/sessions/([^/]+)${suffix}$`))
  return match?.[1]
}

const INTERACTIONS_RE = /^\/v1\/sessions\/([^/]+)\/interactions$/

const bearerToken = (request: IncomingMessage) => {
  const value = request.headers.authorization
  return value?.startsWith("Bearer ") ? value.slice(7) : undefined
}

const isRunnerEvent = (event: SessionInputEvent) =>
  event.type === "ready" || event.type === "status" || event.type === "activity" || event.type.startsWith("runner.") || event.type.startsWith("output_") || event.type.startsWith("turn.") || event.type === "interaction.response" || event.type === "interaction.cancel"

const createRequestHandler = (
  store: SessionStore,
  token: string,
  runDirectory: string,
  persist: () => Promise<void>,
  responses: Set<ServerResponse>,
  controllerIds: Map<string, string>, // sessionId → controllerId
) => async (request: IncomingMessage, response: ServerResponse) => {
  responses.add(response)
  response.once("close", () => responses.delete(response))
  const url = new URL(request.url ?? "/", "http://127.0.0.1")
  const sessionId = pathSessionId(url.pathname)
  const itemsSessionId = pathSessionId(url.pathname, "/items")
  const streamSessionId = pathSessionId(url.pathname, "/stream")
  const eventSessionId = pathSessionId(url.pathname, "/events")
  const interactionsMatch = url.pathname.match(INTERACTIONS_RE)
  const interactionsSessionId = interactionsMatch?.[1]
  const resourceSessionId = sessionId ?? itemsSessionId ?? streamSessionId ?? eventSessionId ?? interactionsSessionId
  const providedToken = bearerToken(request)
  const isParent = providedToken === token
  const isRunner = resourceSessionId !== undefined && providedToken === store.getRunnerToken(resourceSessionId)
  if (!isParent && !isRunner) {
    sendJson(response, 401, { error: "Unauthorized" })
    return
  }

  try {
    const { method } = request
    if (method === "POST" && url.pathname === "/v1/sessions") {
      const body = await readJson(request)
      if (!isRecord(body)) throw new Error("[Session] Invalid session body")
      const session = store.create({
        agent: requiredAgent(body.agent),
        id: randomUUID(),
        role: requiredRole(body.role),
        runDirectory,
        workspace: requiredString(body.workspace, "workspace"),
      })
      await persist()
      sendJson(response, 201, { runnerToken: store.getRunnerToken(session.id), session: store.get(session.id) })
      return
    }

    const eventsSessionId = eventSessionId

    if (method === "GET" && sessionId) {
      const session = store.get(sessionId)
      if (!session) {
        sendJson(response, 404, { error: "Session not found" })
        return
      }
      sendJson(response, 200, { session })
      return
    }
    if (method === "GET" && itemsSessionId) {
      if (!store.get(itemsSessionId)) {
        sendJson(response, 404, { error: "Session not found" })
        return
      }
      sendJson(response, 200, { items: store.getItems(itemsSessionId) })
      return
    }
    if (method === "GET" && streamSessionId) {
      if (!store.get(streamSessionId)) {
        sendJson(response, 404, { error: "Session not found" })
        return
      }
      response.writeHead(200, {
        "cache-control": "no-cache",
        connection: "keep-alive",
        "content-type": "text/event-stream; charset=utf-8",
        "x-accel-buffering": "no",
      })
      response.flushHeaders()
      const unsubscribe = store.subscribe(streamSessionId, event => sendSse(response, event))
      request.once("close", unsubscribe)
      return
    }
    if (method === "GET" && interactionsSessionId) {
      if (!store.get(interactionsSessionId)) {
        sendJson(response, 404, { error: "Session not found" })
        return
      }
      // Read from store's interaction map directly
      sendJson(response, 200, { interactions: store.getInteractions(interactionsSessionId) })
      return
    }
    if (method === "POST" && eventsSessionId) {
      const session = store.get(eventsSessionId)
      if (!session) {
        sendJson(response, 404, { error: "Session not found" })
        return
      }
      const body = await readJson(request)
      if (!isRecord(body)) throw new Error("[Session] Invalid event body")
      const event = body as unknown as SessionInputEvent
      if (typeof event.type !== "string") throw new Error("[Session] Missing required string: type")

      if (!isRunnerEvent(event) && !isParent) {
        sendJson(response, 403, { error: "Parent token required" })
        return
      }

      if (isRunnerEvent(event)) {
        // Runner traffic has a per-session token, so a parent client cannot forge it.
        if (providedToken !== store.getRunnerToken(eventsSessionId)) {
          sendJson(response, 403, { error: "Runner token required" })
          return
        }
        // When a controller lease exists, all runner events except registration
        // must carry a matching controllerId. Otherwise the event is rejected
        // to prevent an unregistered runner from corrupting session state.
        if (event.type !== "runner.ready" && event.type !== "ready") {
          const activeCid = controllerIds.get(eventsSessionId)
          if (activeCid) {
            const eventCid = "controllerId" in event ? event.controllerId : undefined
            if (!eventCid || eventCid !== activeCid) {
              sendJson(response, 403, { error: "ControllerId required or mismatch" })
              return
            }
          }
        }
      }

      if (event.type === "message") {
        if (!isRecord(body.data)) throw new Error("[Session] message.data is required")
        const eventId = requiredString(body.eventId, "eventId")
        const content = requiredString(body.data.content, "data.content")
        const result = store.submitMessage({ content, eventId, sessionId: eventsSessionId })
        await persist()
        sendJson(response, 202, { ...result, eventId })
        return
      }

      // Register controller on runner.ready to detect conflicts
      if (event.type === "runner.ready" || event.type === "ready") {
        const controllerId = randomUUID()
        try {
          store.registerController(eventsSessionId, controllerId)
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          sendJson(response, 409, { error: msg })
          return
        }
        controllerIds.set(eventsSessionId, controllerId)
        // Publish controllerId BEFORE applyEvent so the SSE subscriber sees it before runner.ready.
        // waitForReady captures controllerId from runner.controller, then returns on runner.ready.
        store.publishControllerId(eventsSessionId, controllerId)
        store.applyEvent({ event, sessionId: eventsSessionId })
        await persist()
        sendJson(response, 202, { queued: false, controllerId })
        return
      }

      // Refresh lease on every authenticated runner event (controllerId already verified above).
      const eventCid = "controllerId" in event ? event.controllerId : undefined
      if (isRunnerEvent(event) && eventCid && controllerIds.get(eventsSessionId) === eventCid) {
        store.refreshController(eventsSessionId, eventCid)
      }

      // Release lease when the owning runner reports terminal status.
      if ((event.type === "runner.status" || event.type === "status") && eventCid &&
          controllerIds.get(eventsSessionId) === eventCid &&
          "data" in event && event.data &&
          (event.data.status === "stopped" || event.data.status === "failed")) {
        store.releaseController(eventsSessionId, eventCid)
        controllerIds.delete(eventsSessionId)
      }

      const ack = store.applyEvent({ event, sessionId: eventsSessionId })
      await persist()
      sendJson(response, 202, ack)
      return
    }

    sendJson(response, 404, { error: "Not found" })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!response.headersSent) sendJson(response, 400, { error: message })
  }
}

const listen = (server: Server) => new Promise<number>((resolve, reject) => {
  const onError = (error: Error) => reject(error)
  server.once("error", onError)
  // Loopback is intentional: this API carries a run capability, not user auth.
  server.listen(0, "127.0.0.1", () => {
    server.off("error", onError)
    const address = server.address()
    if (!address || typeof address === "string") {
      reject(new Error("[Session] Could not resolve server address"))
      return
    }
    resolve(address.port)
  })
})

const close = (server: Server) => new Promise<void>((resolve, reject) => {
  server.close(error => error ? reject(error) : resolve())
})

export const createSessionApiServer = (options: ServerOptions): SessionApiServer => {
  let server: Server | undefined
  let started = false
  const token = options.token ?? randomUUID()
  const responses = new Set<ServerResponse>()
  const controllerIds = new Map<string, string>()

  const start = async () => {
    if (started) throw new Error("[Session] Server is already started")
    if (typeof options.runDirectory !== "string" || !options.runDirectory.trim()) {
      throw new Error("[Session] runDirectory is required")
    }
    const snapshot = options.store ? undefined : await readSessionSnapshot(options.runDirectory)
    const store = options.store ?? createSessionStore({ snapshot })
    let persistQueue = Promise.resolve()
    const persist = () => {
      const snapshot = store.snapshot()
      const next = persistQueue.then(async () => {
        await writeSessionSnapshot(options.runDirectory, snapshot)
      })
      // Keep later events writable after one failed request, while preserving that request's error.
      persistQueue = next.catch(() => undefined)
      return next
    }
    server = createServer(createRequestHandler(store, token, options.runDirectory, persist, responses, controllerIds))
    const port = await listen(server)
    started = true
    return { baseUrl: `http://127.0.0.1:${port}`, token }
  }

  const stop = async () => {
    if (!server || !started) return
    for (const response of responses) response.end()
    await close(server)
    responses.clear()
    server = undefined
    started = false
  }

  return { start, stop }
}
