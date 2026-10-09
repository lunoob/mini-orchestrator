import { describe, expect, it, vi } from "vitest"

import { waitForAgentReady } from "./readiness.js"

describe("waitForAgentReady", () => {
  const session = { resumeId: "resume-1", jsonl: "/tmp/session-1.jsonl" }

  it("returns when pane output contains resumeId and jsonl", async () => {
    const read = vi.fn().mockResolvedValue("Codex resume-1 /tmp/session-1.jsonl")

    await expect(waitForAgentReady("pane-1", session, { read, sleep: vi.fn() })).resolves.toBeUndefined()
    expect(read).toHaveBeenCalledTimes(1)
  })

  it("matches jsonl paths split by pane line wrapping", async () => {
    const read = vi.fn().mockResolvedValue(
      "Cursor --resume resume-1\n{\"resumeId\":\"resume-1\",\"jsonl\":\"/tmp/session-1.\njsonl\"}",
    )

    await expect(waitForAgentReady("pane-1", session, { read, sleep: vi.fn() })).resolves.toBeUndefined()
  })

  it("retries every five seconds until the pane is ready", async () => {
    const read = vi.fn()
      .mockResolvedValueOnce("Codex starting")
      .mockResolvedValueOnce("Codex resume-1 /tmp/session-1.jsonl")
    const sleep = vi.fn().mockResolvedValue(undefined)

    await waitForAgentReady("pane-1", session, { read, sleep })

    expect(read).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledWith(5_000)
  })

  it("counts pane output read errors as unsuccessful attempts", async () => {
    const read = vi.fn()
      .mockRejectedValueOnce(new Error("temporary herdr error"))
      .mockResolvedValueOnce("Codex resume-1 /tmp/session-1.jsonl")
    const sleep = vi.fn().mockResolvedValue(undefined)

    await waitForAgentReady("pane-1", session, { read, sleep })

    expect(read).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledTimes(2)
  })

  it("includes the latest pane output after six unsuccessful attempts", async () => {
    const read = vi.fn().mockResolvedValue("Codex starting")
    const sleep = vi.fn().mockResolvedValue(undefined)

    await expect(waitForAgentReady("pane-1", session, { read, sleep })).rejects.toThrow(
      "Agent CLI 启动失败\nMatch: resumeId=false, jsonl=false\nPane output:\nCodex starting",
    )
    expect(read).toHaveBeenCalledTimes(6)
    expect(sleep).toHaveBeenCalledTimes(6)
  })
})
