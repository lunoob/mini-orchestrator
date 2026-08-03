import { describe, expect, it } from "vitest"

describe("readAgentOutputWithRetry", () => {
  // 使用真计时器 + 极短间隔避免测试耗时，同时避开 fake timers 与 async readFn 的交互问题

  const makeReadFn = (responses: string[]) => {
    let callCount = 0
    return () => {
      const res = responses[callCount] ?? responses[responses.length - 1]
      callCount++
      return Promise.resolve(res)
    }
  }

  it("returns output immediately if valid on first attempt", async () => {
    const { readAgentOutputWithRetry } = await import("./index.js")
    const readFn = makeReadFn(["STATUS: IMPLEMENT_DONE\nDone."])

    const result = await readAgentOutputWithRetry(
      "p1", 280,
      (o) => o.includes("STATUS:"),
      3, 1,
      readFn as any,
    )

    expect(result).toContain("STATUS: IMPLEMENT_DONE")
  })

  it("retries when output does not pass validation", async () => {
    const { readAgentOutputWithRetry } = await import("./index.js")
    const readFn = makeReadFn([
      "",                                          // 空 — 无效
      "some logs but no status",                   // 无 STATUS — 无效
      "OK\nSTATUS: IMPLEMENT_DONE",                // 有效
    ])

    const isValid = (o: string) => /STATUS:\s*\w+/.test(o)

    const result = await readAgentOutputWithRetry("p2", 280, isValid, 3, 1, readFn as any)

    expect(result).toContain("OK")
  })

  it("throws after max retries with sync error message", async () => {
    const { readAgentOutputWithRetry } = await import("./index.js")
    const readFn = makeReadFn(["", "", ""]) // 全部无效

    await expect(
      readAgentOutputWithRetry("p3", 280, (o) => o.trim().length > 0, 3, 1, readFn as any),
    ).rejects.toThrow(/output not synced/)
  })

  it("does not retry if validation passes on second attempt", async () => {
    const { readAgentOutputWithRetry } = await import("./index.js")
    const readFn = makeReadFn([
      "incomplete",                    // 无 STATUS — 无效
      "FINAL\nSTATUS: IMPLEMENT_DONE", // 有效
    ])

    const isValid = (o: string) => /STATUS:\s*\w+/.test(o)

    const result = await readAgentOutputWithRetry("p4", 280, isValid, 3, 1, readFn as any)

    expect(result).toContain("FINAL")
  })
})
