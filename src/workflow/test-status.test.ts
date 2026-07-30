import { describe, expect, it } from "vitest"

import { parseImplementStatus, stripStatusLines } from "../lib/utils.js"
import { buildTestStatusPrompt, loadImplementOutputFormat } from "./test-status.js"

describe("testStatus prompt and output parsing", () => {
  it("appends implement-output format with STATUS instructions to the prompt", async () => {
    const outputFormat = await loadImplementOutputFormat()
    const prompt = buildTestStatusPrompt(outputFormat)

    expect(prompt).toContain("查询今天佛山天气")
    // 新 prompt partial 包含 STATUS 指令而非分隔线
    // 新 prompt partial 包含 STATUS 指令
    expect(prompt).toContain("IMPLEMENT_DONE")
    expect(prompt).toContain("IMPLEMENT_ASK")
    expect(outputFormat).toContain("IMPLEMENT_DONE")
    expect(outputFormat).toContain("IMPLEMENT_ASK")
  })

  it("parses implement status from output (no delimiter needed)", () => {
    const raw = [
      "some agent chatter",
      "佛山今天多云，气温 28°C。",
      "STATUS: IMPLEMENT_DONE",
    ].join("\n")

    const status = parseImplementStatus(raw)
    const printable = stripStatusLines(raw)

    // extractImplementResult 现在是透传，原样保留
    expect(status).toBe("done")
    expect(printable).toContain("佛山今天多云")
    expect(printable).not.toMatch(/STATUS:/)
  })
})
