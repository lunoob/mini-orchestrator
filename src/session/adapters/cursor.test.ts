import { describe, expect, test, vi } from "vitest"

import { createCursorAdapter } from "./cursor.js"
import { runAdapterContractTests } from "./adapter-contract-suite.js"

// ---- 共享 SessionAdapter contract 测试 ----

runAdapterContractTests({
  createAdapter: transport => createCursorAdapter({
    agent: { agent: "cursor", command: "cursor-agent", model: "composer-2.5-high", name: "cursor" },
    cwd: "/tmp/project",
    transport: transport as Parameters<typeof createCursorAdapter>[0]["transport"],
  }),
})

// ---- Cursor 特有测试 ----

describe("CursorAdapter", () => {
  const makeCursorTransport = () => ({
    cancel: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    onEvent: vi.fn(() => () => undefined),
    send: vi.fn(async () => ({ turnId: "cursor-raw-1" })),
    start: vi.fn(async () => undefined),
  })

  test("rejects effort configuration with diagnostic pointing to model suffix", () => {
    const transport = makeCursorTransport()
    expect(() =>
      createCursorAdapter({
        agent: { agent: "cursor", command: "cursor-agent", effort: "high", name: "cursor" },
        cwd: "/tmp/project",
        transport,
      }),
    ).toThrow(/effort.*cursor.*model suffix/i)
  })

  test("passes model from config on each send", async () => {
    const transport = makeCursorTransport()
    const adapter = createCursorAdapter({
      agent: { agent: "cursor", command: "cursor-agent", model: "composer-2.5-high", name: "cursor" },
      cwd: "/tmp/project",
      transport,
    })

    await adapter.start()
    await adapter.deliverMessage({ content: "prompt", turnId: "turn-model" })

    expect(transport.send).toHaveBeenCalledWith({ content: "prompt", model: "composer-2.5-high" })
  })
})
