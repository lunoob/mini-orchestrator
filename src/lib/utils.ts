import { parseAgentOutput } from "./status-parser.js"

export type ImplementStatus = "done" | "needs_input" | "unknown"

/**
 * @deprecated 使用 parseAgentOutput 替代；保留以兼容旧测试和旧代码路径
 */
export const parseImplementStatus = (output: string): ImplementStatus => {
  const result = parseAgentOutput(output, "implementer")
  if (result.status === "completed") return "done"
  if (result.status === "needs_input") return "needs_input"
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

/**
 * @deprecated 使用 parseAgentOutput 替代；保留以兼容旧代码路径
 */
export const parseReviewVerdict = (output: string): ReviewVerdict => {
  const result = parseAgentOutput(output, "reviewer")

  const cannotVerifySummary = extractCannotVerifySummary(output)
  const hasCannotVerify = cannotVerifySummary !== null

  // parseAgentOutput 的结果映射回 ReviewVerdict
  if (result.status === "completed" && "statusValue" in result) {
    const kind: ReviewVerdictKind =
      result.statusValue === "REVIEW_PASS" ? "pass"
      : result.statusValue === "REVIEW_FAIL" ? "fail"
      : hasCannotVerify ? "needs_check"
      : "fail"

    return {
      cannotVerifySummary,
      hasCannotVerify,
      kind,
      passed: kind === "pass",
    }
  }

  if (result.status === "needs_input") {
    return {
      cannotVerifySummary,
      hasCannotVerify,
      kind: "needs_check",
      passed: false,
    }
  }

  // invalid_output → fail
  return {
    cannotVerifySummary,
    hasCannotVerify,
    kind: "fail",
    passed: false,
  }
}

/**
 * @deprecated 不再使用分隔线标记；保留以兼容旧代码路径
 */
export const extractReviewResult = (output: string): string => output

/**
 * @deprecated 不再使用分隔线标记；保留以兼容旧代码路径
 */
export const extractImplementResult = (output: string): string => output

/** 整行 STATUS 标记（允许前导空白）；每次新建 RegExp，避免 g 标志的 lastIndex 串扰 */
const STATUS_LINE_PATTERN = "^[ \\t]*STATUS: .+$"
const statusLineRe = () => new RegExp(STATUS_LINE_PATTERN, "gm")

export const stripStatusLines = (output: string): string =>
  output
    .replaceAll("\\n", "\n")
    .trim()
    .replace(statusLineRe(), "")
    .trim()

/** 仅保留 STATUS 行，供控制台摘要打印（避免刷完整 agent 输出） */
export const extractStatusLines = (output: string): string => {
  const normalized = output.replaceAll("\\n", "\n")
  const matches = normalized.match(statusLineRe())
  if (!matches) return ""
  return matches.map((line) => line.trim()).join("\n")
}

export const printSection = (title: string, body: string) => {
  console.log(`\n=== ${title} ===\n`)
  console.log(body.trim())
}

export const render = (template: string, values: Record<string, string>) =>
  template.replaceAll(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) =>
    key in values ? values[key] : match,
  )

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
