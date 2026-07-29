import { describe, expect, test, vi } from "vitest"

import { createClaudeAdapter } from "./claude.js"
import { runAdapterContractTests } from "./adapter-contract-suite.js"

// ---- 共享 SessionAdapter contract 测试 ----

runAdapterContractTests({
  createAdapter: transport => createClaudeAdapter({
    agent: { agent: "claude", command: "claude", name: "claude" },
    cwd: "/tmp/project",
    transport: transport as Parameters<typeof createClaudeAdapter>[0]["transport"],
  }),
})

// ---- Claude 特有测试 ----

describe("ClaudeAdapter", () => {
  const makeClaudeTransport = () => ({
    cancel: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    onEvent: vi.fn(() => () => undefined),
    send: vi.fn(async () => ({ turnId: "claude-raw-1" })),
    start: vi.fn(async () => undefined),
  })

  test("effort levels are validated and passed through", async () => {
    const transport = makeClaudeTransport()
    const adapter = createClaudeAdapter({
      agent: { agent: "claude", command: "claude", effort: "xhigh", name: "claude" },
      cwd: "/tmp/project",
      transport,
    })

    await adapter.start()
    await adapter.deliverMessage({ content: "prompt", turnId: "turn-effort" })

    expect(transport.send).toHaveBeenCalledWith({ content: "prompt", effort: "xhigh" })
  })

  test("rejects invalid effort values", async () => {
    const transport = makeClaudeTransport()
    const adapter = createClaudeAdapter({
      agent: { agent: "claude", command: "claude", effort: "invalid", name: "claude" },
      cwd: "/tmp/project",
      transport,
    })

    await expect(adapter.start()).rejects.toThrow(/effort.*claude/i)
  })
})
