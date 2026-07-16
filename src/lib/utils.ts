import {
  IMPLEMENT_RESULT_END,
  IMPLEMENT_RESULT_START,
  REVIEW_RESULT_END,
  REVIEW_RESULT_START,
} from "./prompt-delimiters.js"

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

  const kind: ReviewVerdictKind =
    explicitFail ? "fail" :
    (explicitNeedsCheck || hasCannotVerify) ? "needs_check" :
    explicitPass ? "pass" :
    "fail"

  return {
    cannotVerifySummary,
    hasCannotVerify,
    kind,
    passed: kind === "pass",
  }
}

export const extractReviewResult = (output: string): string => {
  const startIdx = output.lastIndexOf(REVIEW_RESULT_START)
  if (startIdx === -1) return output

  const afterStart = startIdx + REVIEW_RESULT_START.length
  const endIdx = output.lastIndexOf(REVIEW_RESULT_END)
  if (endIdx <= afterStart) return output

  return output.slice(afterStart, endIdx).trim() || output
}

export const extractImplementResult = (output: string): string => {
  const startIdx = output.lastIndexOf(IMPLEMENT_RESULT_START)
  if (startIdx === -1) return output

  const afterStart = startIdx + IMPLEMENT_RESULT_START.length
  const endIdx = output.lastIndexOf(IMPLEMENT_RESULT_END)
  if (endIdx <= afterStart) return output

  return output.slice(afterStart, endIdx).trim() || output
}

export const stripStatusLines = (output: string): string =>
  output
    .replaceAll("\\n", "\n")
    .trim()
    .replace(/^[ \t]*STATUS: .+$/gm, "")
    .trim()

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
