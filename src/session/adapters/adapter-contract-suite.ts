import { describe, expect, test, vi } from "vitest"

import type { AdapterEvent, SessionAdapter } from "./types.js"

type RawEvent = {
  done?: boolean
  failed?: boolean
  interrupted?: boolean
  text?: string
  turnId: string
}

type RawTransport = {
  cancel: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  onEvent: (listener: (event: RawEvent) => void) => () => void
  onExit?: (listener: (error: Error) => void) => () => void
  send: ReturnType<typeof vi.fn>
  start: ReturnType<typeof vi.fn>
}

type ContractFixture = {
  createAdapter: (transport: RawTransport) => SessionAdapter
  /** send 调用时期望的额外参数（如 model、effort） */
  sendParams?: Record<string, string>
}

/** 创建通用的 fake transport，send 每次返回唯一 turn ID */
const makeTransport = (prefix: string) => {
  const listeners: Array<(event: RawEvent) => void> = []
  let sendCount = 0
  const send = vi.fn(async () => {
    sendCount += 1
    return { turnId: `${prefix}-${sendCount}` }
  })
  const cancel = vi.fn(async () => undefined)
  const transport: RawTransport = {
    cancel,
    close: vi.fn(async () => undefined),
    onEvent: (listener) => {
      listeners.push(listener)
      return () => { const i = listeners.indexOf(listener); if (i >= 0) listeners.splice(i, 1) }
    },
    send,
    start: vi.fn(async () => undefined),
  }
  return { cancel, listeners, send, transport }
}

/** 共享 adapter contract suite，参数化 fixture 后由各 adapter 测试文件调用 */
export const runAdapterContractTests = (fixture: ContractFixture) => {
  describe("SessionAdapter contract", () => {
    test("delivers each turn once and converts streamed text to Session events", async () => {
      const { listeners, send, transport } = makeTransport("raw")
      const emitted: AdapterEvent[] = []
      const adapter = fixture.createAdapter(transport)
      adapter.onEvent(e => { emitted.push(e) })

      await adapter.start()
      await adapter.deliverMessage({ content: "prompt", turnId: "turn-1" })
      // 重复投递同一 turnId 应被忽略
      await adapter.deliverMessage({ content: "prompt", turnId: "turn-1" })
      listeners[0]({ text: "hello", turnId: "raw-1" })
      listeners[0]({ text: " world", turnId: "raw-1" })
      listeners[0]({ done: true, turnId: "raw-1" })
      await adapter.dispose()

      expect(send).toHaveBeenCalledTimes(1)
      expect(emitted).toEqual([
        { data: { delta: "hello", turnId: "turn-1" }, type: "output_text.delta" },
        { data: { delta: " world", turnId: "turn-1" }, type: "output_text.delta" },
        { data: { turnId: "turn-1" }, type: "turn.completed" },
      ])
    })

    test("maps turn.failed from error events", async () => {
      const { listeners, transport } = makeTransport("raw")
      const emitted: AdapterEvent[] = []
      const adapter = fixture.createAdapter(transport)
      adapter.onEvent(e => { emitted.push(e) })

      await adapter.start()
      await adapter.deliverMessage({ content: "prompt", turnId: "turn-2" })
      listeners[0]({ failed: true, text: "error reason", turnId: "raw-1" })
      await adapter.dispose()

      expect(emitted).toEqual([
        { data: { reason: "error reason", turnId: "turn-2" }, type: "turn.failed" },
      ])
    })

    test("maps turn.interrupted from interrupt events", async () => {
      const { listeners, transport } = makeTransport("raw")
      const emitted: AdapterEvent[] = []
      const adapter = fixture.createAdapter(transport)
      adapter.onEvent(e => { emitted.push(e) })

      await adapter.start()
      await adapter.deliverMessage({ content: "prompt", turnId: "turn-3" })
      listeners[0]({ interrupted: true, turnId: "raw-1" })
      await adapter.dispose()

      expect(emitted).toEqual([
        { data: { turnId: "turn-3" }, type: "turn.interrupted" },
      ])
    })

    test("interrupt calls transport.cancel and does not emit turn.interrupted directly", async () => {
      const { cancel, transport } = makeTransport("raw")
      const emitted: AdapterEvent[] = []
      const adapter = fixture.createAdapter(transport)
      adapter.onEvent(e => { emitted.push(e) })

      await adapter.start()
      await adapter.deliverMessage({ content: "prompt", turnId: "turn-cancel" })
      await adapter.interrupt("turn-cancel")

      expect(cancel).toHaveBeenCalledWith("raw-1")
      expect(emitted).toEqual([])
    })

    test("emits adapter events via onEvent subscriber", async () => {
      const { listeners, transport } = makeTransport("raw")
      const emitted: AdapterEvent[] = []
      const adapter = fixture.createAdapter(transport)
      const unsubscribe = adapter.onEvent(e => { emitted.push(e) })

      await adapter.start()
      await adapter.deliverMessage({ content: "prompt", turnId: "turn-4" })
      listeners[0]({ text: "data", turnId: "raw-1" })
      listeners[0]({ done: true, turnId: "raw-1" })
      await adapter.dispose()

      expect(emitted).toHaveLength(2)

      // 取消订阅后不再收到事件
      unsubscribe()
      const emittedAfter: AdapterEvent[] = []
      adapter.onEvent(e => { emittedAfter.push(e) })
      expect(emittedAfter).toHaveLength(0)
    })

    test("exit only fails active turns, not terminal ones", async () => {
      const { listeners, transport } = makeTransport("raw")
      let exitListener: ((error: Error) => void) | undefined
      const failingTransport: RawTransport = {
        ...transport,
        onExit: (listener) => {
          exitListener = listener
          return () => { exitListener = undefined }
        },
      }
      const emitted: AdapterEvent[] = []
      const adapter = fixture.createAdapter(failingTransport)
      adapter.onEvent(e => { emitted.push(e) })

      await adapter.start()
      // turn-6 先完成
      await adapter.deliverMessage({ content: "prompt", turnId: "turn-6" })
      listeners[0]({ done: true, turnId: "raw-1" })
      // turn-7 仍在活跃
      await adapter.deliverMessage({ content: "prompt", turnId: "turn-7" })
      exitListener?.(new Error("process exited"))
      await adapter.dispose()

      const turn6Events = emitted.filter(e => e.data.turnId === "turn-6")
      const turn7Events = emitted.filter(e => e.data.turnId === "turn-7")
      expect(turn6Events).toEqual([
        { data: { turnId: "turn-6" }, type: "turn.completed" },
      ])
      expect(turn7Events.some(e => e.type === "turn.failed")).toBe(true)
    })

    test("stops transport on dispose", async () => {
      const { transport } = makeTransport("raw")
      const adapter = fixture.createAdapter(transport)

      await adapter.start()
      await adapter.dispose()

      expect(transport.close).toHaveBeenCalledTimes(1)
    })

    test("passes config parameters to transport.send", async () => {
      if (!fixture.sendParams || Object.keys(fixture.sendParams).length === 0) return
      const { send, transport } = makeTransport("raw")
      const adapter = fixture.createAdapter(transport)

      await adapter.start()
      await adapter.deliverMessage({ content: "prompt", turnId: "turn-params" })

      expect(send).toHaveBeenCalledWith({ content: "prompt", ...fixture.sendParams })
    })
  })
}
