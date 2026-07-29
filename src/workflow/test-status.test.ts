import { describe, expect, it } from "vitest"

import {
  IMPLEMENT_RESULT_END,
  IMPLEMENT_RESULT_START,
} from "../lib/prompt-delimiters.js"
import { extractImplementResult, parseImplementStatus, stripStatusLines } from "../lib/utils.js"
import { buildTestStatusPrompt } from "./test-status.js"

describe("testStatus prompt and output parsing", () => {
  it("builds prompt with implement-output format and delimiters", () => {
    const outputFormat = [
      "## 输出",
      "必须严格遵循以下步骤:",
      `1. 先输出起始前缀: ${IMPLEMENT_RESULT_START}`,
      "2. 再输出其他内容（含 STATUS 标记）",
      `3. 最后输出结束后缀: ${IMPLEMENT_RESULT_END}`,
    ].join("\n")
    const prompt = buildTestStatusPrompt(outputFormat)

    expect(prompt).toContain("查询今天佛山天气")
    expect(prompt).toContain(IMPLEMENT_RESULT_START)
    expect(prompt).toContain(IMPLEMENT_RESULT_END)
  })

  it("strips delimiters and parses implement status like workflow", () => {
    const raw = [
      "some agent chatter",
      IMPLEMENT_RESULT_START,
      "佛山今天多云，气温 28°C。",
      "STATUS: IMPLEMENT_DONE",
      IMPLEMENT_RESULT_END,
    ].join("\n")

    const resultBody = extractImplementResult(raw)
    const status = parseImplementStatus(resultBody)
    const printable = stripStatusLines(resultBody)

    expect(resultBody).toContain("佛山今天多云")
    expect(resultBody).not.toContain(IMPLEMENT_RESULT_START)
    expect(resultBody).not.toContain(IMPLEMENT_RESULT_END)
    expect(status).toBe("done")
    expect(printable).toContain("佛山今天多云")
    expect(printable).not.toMatch(/STATUS:/)
  })
})
