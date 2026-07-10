export type ImplementStatus = "done" | "needs_input" | "unknown"

export const parseImplementStatus = (output: string): ImplementStatus => {
  if (hasStatus(output, "IMPLEMENT_DONE")) return "done"
  if (hasStatus(output, "IMPLEMENT_ASK")) return "needs_input"
  return "unknown"
}

export const assertHerdrEnv = () => {
  if (process.env.HERDR_ENV === "1") return
  throw new Error("[Config] HERDR_ENV is not set to 1. Please run this inside a herdr pane.")
}

export const getErrorMessage = (error: unknown) => {
  if (error instanceof Error) return error.message
  return String(error)
}

export const hasStatus = (output: string, status: string) =>
  new RegExp(`STATUS: ${status}`, "m").test(output.trim())

export type ReviewVerdictKind = "pass" | "fail" | "needs_check"

export type ReviewVerdict = {
  cannotVerifySummary: string | null
  hasCannotVerify: boolean
  kind: ReviewVerdictKind
  passed: boolean
}

const extractCannotVerifySummary = (output: string) => {
  const match = output.match(
    /⚠️\s*Cannot verify from diff:\s*([\s\S]*?)(?=\n### |\n#### |\n- ✅|\n- ❌|$)/i,
  )
  if (!match) return null

  const body = match[1].trim()
  if (!body || /^\(none\)$/i.test(body) || body === "无") return null

  return body
}

export const parseReviewVerdict = (output: string): ReviewVerdict => {
  const explicitPass = hasStatus(output, "REVIEW_PASS")
  const explicitFail = hasStatus(output, "REVIEW_FAIL")
  const explicitNeedsCheck = hasStatus(output, "REVIEW_NEEDS_CHECK")

  const cannotVerifySummary = extractCannotVerifySummary(output)
  const hasCannotVerify = cannotVerifySummary !== null

  // 根据 review prompt 的设计，三个状态标记互斥；安全优先排序
  const kind: ReviewVerdictKind =
    explicitFail ? "fail" :
    (explicitNeedsCheck || hasCannotVerify) ? "needs_check" :
    explicitPass ? "pass" :
    /* 无任何状态标记 */ "fail"

  return {
    cannotVerifySummary,
    hasCannotVerify,
    kind,
    passed: kind === "pass",
  }
}

const REVIEW_DELIMITER_START = "---REVIEW_RESULT_START---"
const REVIEW_DELIMITER_END = "---REVIEW_RESULT_END---"
const IMPLEMENT_DELIMITER_START = "---IMPLEMENT_RESULT_START---"
const IMPLEMENT_DELIMITER_END = "---IMPLEMENT_RESULT_END---"

/**
 * 从 reviewer 的完整终端输出中提取最后一对标记之间的最终结果。
 * 终端输出可能包含多对标记（prompt 中的格式说明 + reviewer 的实际回复），
 * 用 lastIndexOf 取最后那对，即 reviewer 本次实际输出的内容。
 * 标记缺失时回退到原始输出，不打断工作流。
 */
export const extractReviewResult = (output: string): string => {
  const startIdx = output.lastIndexOf(REVIEW_DELIMITER_START)
  if (startIdx === -1) return output

  const afterStart = startIdx + REVIEW_DELIMITER_START.length
  const endIdx = output.indexOf(REVIEW_DELIMITER_END, afterStart)
  if (endIdx === -1) return output

  return output.slice(afterStart, endIdx).trim() || output
}

/**
 * 从 implementer 的完整终端输出中提取最后一对标记之间的最终结果。
 * 标记缺失时回退到原始输出，不打断工作流。
 */
export const extractImplementResult = (output: string): string => {
  const startIdx = output.lastIndexOf(IMPLEMENT_DELIMITER_START)
  if (startIdx === -1) return output

  const afterStart = startIdx + IMPLEMENT_DELIMITER_START.length
  const endIdx = output.indexOf(IMPLEMENT_DELIMITER_END, afterStart)
  if (endIdx === -1) return output

  return output.slice(afterStart, endIdx).trim() || output
}

/**
 * 从输出中移除编排器专用的 STATUS 标记行，只保留对人类 agent 有意义的内容。
 * 用于将 reviewOutput 注入 revise / controller 等 prompt 前清理。
 */
export const stripStatusLines = (output: string): string =>
  output.replace(/^\s*STATUS: .+$/gm, "").trim()

export const printSection = (title: string, body: string) => {
  console.log(`\n=== ${title} ===\n`)
  console.log(body.trim())
}

export const render = (template: string, values: Record<string, string>) =>
  template.replaceAll(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) => values[key] ?? "")

export const splitCommand = (command: string) => {
  const parts: string[] = []
  let current = ""
  let quote: '"' | "'" | undefined

  for (const char of command) {
    if ((char === '"' || char === "'") && !quote) {
      quote = char
      continue
    }

    if (char === quote) {
      quote = undefined
      continue
    }

    if (char === " " && !quote) {
      if (current) parts.push(current)
      current = ""
      continue
    }

    current += char
  }

  if (current) parts.push(current)
  return parts
}
