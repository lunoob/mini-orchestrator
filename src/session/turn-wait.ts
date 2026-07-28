import type { SessionClient } from "./client.js"
import type { SessionItem, Turn, TurnWaitResult } from "./types.js"

const terminal = new Set(["completed", "failed", "interrupted"])

export const waitForTurn = async (
  client: SessionClient,
  sessionId: string,
  turnId: string,
): Promise<TurnWaitResult> => {
  const items = new Map<string, SessionItem>()
  const reconcile = async () => {
    const [session, savedItems] = await Promise.all([
      client.get(sessionId),
      client.getItems(sessionId),
    ])
    for (const item of savedItems) items.set(item.id, item)
    const turn = session.turns.find(candidate => candidate.id === turnId)
    if (!turn) throw new Error(`[Session] Unknown turn: ${turnId}`)
    const output = [...items.values()].find(item => item.role === "assistant" && item.turnId === turnId)
    return { output, turn }
  }

  const initial = await reconcile()
  if (terminal.has(initial.turn.status)) return initial

  while (true) {
    // Reconcile before reconnecting so a terminal event delivered during the gap wins over live tailing.
    const beforeReconnect = await reconcile()
    if (terminal.has(beforeReconnect.turn.status)) return beforeReconnect

    let reconnect = false
    const iterator = client.stream(sessionId)[Symbol.asyncIterator]()
    try {
      // SSE is live-tail only, so every new subscription must reconcile before trusting live events.
      const connected = await iterator.next()
      if (connected.done) {
        reconnect = true
      } else {
        const afterConnect = await reconcile()
        if (terminal.has(afterConnect.turn.status)) return afterConnect

        while (true) {
          const next = await iterator.next()
          if (next.done) {
            reconnect = true
            break
          }
          if (next.value.turnId !== turnId || !next.value.type.startsWith("turn.")) continue
          const afterTerminal = await reconcile()
          if (terminal.has(afterTerminal.turn.status)) return afterTerminal
        }
      }
    } catch {
      reconnect = true
    } finally {
      await iterator.return?.()
    }
    if (!reconnect) throw new Error(`[Session] Stream closed before turn completion: ${turnId}`)
  }
}
