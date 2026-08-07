import { describe, expect, it } from "vitest"

import { extractStatus } from "../lib/status-parser.js"
import { buildTestStatusPrompt, loadImplementOutputFormat, TEST_STATUS_CONFIG } from "./test-status.js"

describe("testStatus prompt and output parsing", () => {
  it("defines the built-in agent config", () => {
    expect(TEST_STATUS_CONFIG.agents.implementer).toEqual({
      agent: "codex",
      model: "gpt-5.6-luna",
      name: "test-status",
    })
  })

  it("appends implement-output format with STATUS instructions", async () => {
    const outputFormat = await loadImplementOutputFormat()
    const prompt = buildTestStatusPrompt(outputFormat)

    expect(prompt).toContain("查询今天佛山天气")
    expect(outputFormat).toContain("STATUS: IMPLEMENT_DONE")
  })

  it("parses IMPLEMENT_DONE from STATUS marker", () => {
    expect(extractStatus("完成\nSTATUS: IMPLEMENT_DONE", "implementer")).toBe("IMPLEMENT_DONE")
  })

  it("parses IMPLEMENT_ASK from STATUS marker", () => {
    expect(extractStatus("STATUS: IMPLEMENT_ASK", "implementer")).toBe("IMPLEMENT_ASK")
  })

  it("extracts status from text with other content", () => {
    const raw = "佛山今天多云\nSTATUS: IMPLEMENT_DONE"
    expect(extractStatus(raw, "implementer")).toBe("IMPLEMENT_DONE")
  })

  it("returns null when no STATUS marker", () => {
    expect(extractStatus("没有状态标记", "implementer")).toBeNull()
  })
})
