import { isProtocolError, parseOutcome, type AgentOutcome } from "./outcome-parser.js"

export const assertHerdrEnv = () => {
  if (process.env.HERDR_ENV === "1") return
  throw new Error("[Config] HERDR_ENV is not set to 1. Please run this inside a herdr pane.")
}

export const getErrorMessage = (error: unknown) => {
  if (error instanceof Error) return error.message
  return String(error)
}

export type ReviewVerdictKind = "pass" | "fail" | "needs_check"

export type ReviewVerdict = {
  cannotVerifySummary: string | null
  hasCannotVerify: boolean
  kind: ReviewVerdictKind
  passed: boolean
}

/**
 * 从 agent 输出中移除末尾 JSON outcome 块，仅保留业务内容。
 * 先尝试整体 JSON.parse；若失败则从后往前找并移除末尾 JSON。
 */
export const stripAgentOutcome = (output: string): string => {
  const normalized = output.replaceAll("\\n", "\n").trimEnd()

  // 纯 JSON outcome 时提取 report 字段内容（用于 revise 流程传递 reviewer 反馈）
  // P2-5: 没有 report 时用 summary 作为 fallback，避免 revise/controller prompt 收不到反馈
  try {
    const parsed = JSON.parse(normalized.trim())
    if (typeof parsed === "object" && parsed !== null) {
      if (typeof parsed.report === "string" && parsed.report.trim()) {
        return parsed.report.trim()
      }
      // fallback: 使用 summary
      if (typeof parsed.summary === "string" && parsed.summary.trim()) {
        return parsed.summary.trim()
      }
    }
    return ""
  } catch { /* 有混合内容 */ }

  // 从后往前找最后一个 JSON 对象，正确跳过字符串内容
  const len = normalized.length
  let end = len - 1
  while (end >= 0 && /\s/.test(normalized[end])) end--
  if (end < 0 || normalized[end] !== "}") return normalized.trim()

  let depth = 0
  let inString = false
  let escape = false
  let jsonStart = -1
  for (let i = end; i >= 0; i--) {
    const ch = normalized[i]
    if (escape) { escape = false; continue }
    if (ch === "\\") { escape = true; continue }
    if (ch === '"') { inString = !inString; continue }
    if (inString) continue
    if (ch === "}") depth++
    else if (ch === "{") depth--
    if (depth === 0) { jsonStart = i; break }
  }
  if (jsonStart >= 0 && jsonStart < len) {
    // 验证是合法 JSON outcome
    const candidate = normalized.slice(jsonStart, end + 1)
    try {
      const parsed = JSON.parse(candidate)
      if (typeof parsed === "object" && parsed !== null && "outcome" in parsed) {
        return normalized.slice(0, jsonStart).trim()
      }
    } catch { /* 非 JSON */ }
  }
  return normalized.trim()
}


export const extractOutcomeSummary = (output: string): string => {
  const result = parseOutcome(output, "reviewer")
  if (!isProtocolError(result) && result.outcome !== "failed") return formatOutcome(result)

  const implResult = parseOutcome(output, "implementer")
  if (!isProtocolError(implResult)) return formatOutcome(implResult)

  return `PROTOCOL_ERROR: ${isProtocolError(result) ? result.reason : ""}`
}

const formatOutcome = (outcome: AgentOutcome): string => {
  switch (outcome.outcome) {
    case "completed":
      return "review" in outcome && outcome.review
        ? `REVIEW_${outcome.review.verdict.toUpperCase()}`
        : "IMPLEMENT_DONE"
    case "needs_input":
      return `QUESTION: ${outcome.request.question.slice(0, 100)}`
    case "failed":
      return `FAILED: ${outcome.failure.message.slice(0, 100)}`
  }
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
