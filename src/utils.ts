export type ImplementStatus = "done" | "needs_input" | "unknown"

export const parseImplementStatus = (output: string): ImplementStatus => {
  if (hasStatus(output, "IMPLEMENT_DONE")) return "done"
  if (hasStatus(output, "IMPLEMENT_ASK")) return "needs_input"
  return "unknown"
}

export const assertHerdrEnv = () => {
  if (process.env.HERDR_ENV === "1") return
  throw new Error("HERDR_ENV is not set to 1. Please run this inside a herdr pane.")
}

export const getErrorMessage = (error: unknown) => {
  if (error instanceof Error) return error.message
  return String(error)
}

export const hasStatus = (output: string, status: string) =>
  new RegExp(`^STATUS: ${status}$`, "m").test(output.trim())

export type ReviewVerdictKind = "pass" | "fail" | "needs_check"

export type ReviewVerdict = {
  cannotVerifySummary: string | null
  hasBlockingIssues: boolean
  hasCannotVerify: boolean
  kind: ReviewVerdictKind
  passed: boolean
  qualityApproved: boolean | null
  specCompliant: boolean | null
}

const hasIssuesInSection = (output: string, section: string) => {
  const match = output.match(
    new RegExp(`####\\s*${section}[^\\n]*\\n([\\s\\S]*?)(?=\\n####|\\n### |$)`, "i"),
  )
  if (!match) return false

  const body = match[1].trim()
  if (!body || /^\(none\)$/i.test(body) || /^无$/i.test(body)) return false

  return /^\s*[\d*-]/m.test(body)
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

  const specCompliant =
    /Spec Compliance[^\n]*✅/i.test(output) ||
    /spec compliant/i.test(output) ||
    hasStatus(output, "SPEC_PASS")

  const specFailed =
    /Spec Compliance[^\n]*❌/i.test(output) ||
    /Issues found:/i.test(output) ||
    hasStatus(output, "SPEC_FAIL")

  const qualityApproved =
    /(?:Task quality|Quality):\s*Approved/i.test(output) || hasStatus(output, "QUALITY_PASS")

  const qualityNeedsFix =
    /(?:Task quality|Quality):\s*Needs fixes/i.test(output) || hasStatus(output, "QUALITY_FAIL")

  const hasBlockingIssues =
    hasIssuesInSection(output, "Critical") || hasIssuesInSection(output, "Important")

  const cannotVerifySummary = extractCannotVerifySummary(output)
  const hasCannotVerify = cannotVerifySummary !== null

  const hasFixableFailures = specFailed || qualityNeedsFix || hasBlockingIssues

  const dualVerdictPass =
    specCompliant &&
    !specFailed &&
    qualityApproved &&
    !qualityNeedsFix &&
    !hasBlockingIssues &&
    !hasCannotVerify

  const passed =
    (explicitPass || dualVerdictPass) && !explicitFail && !explicitNeedsCheck && !hasFixableFailures

  let kind: ReviewVerdictKind
  if (passed) {
    kind = "pass"
  } else if (hasFixableFailures || (explicitFail && !explicitNeedsCheck)) {
    kind = "fail"
  } else if (explicitNeedsCheck || hasCannotVerify) {
    kind = "needs_check"
  } else {
    kind = "fail"
  }

  return {
    cannotVerifySummary,
    hasBlockingIssues,
    hasCannotVerify,
    kind,
    passed: kind === "pass",
    qualityApproved: qualityApproved ? true : qualityNeedsFix ? false : null,
    specCompliant: specCompliant ? true : specFailed ? false : null,
  }
}

const REVIEW_DELIMITER_START = "---REVIEW_RESULT_START---"
const REVIEW_DELIMITER_END = "---REVIEW_RESULT_END---"

/**
 * 从 reviewer 的完整终端输出中提取两个标记之间的最终结果。
 * 先找 ---REVIEW_RESULT_START---（丢弃前面的分析内容），再找其后的
 * ---REVIEW_RESULT_END---（取中间内容）。
 * 标记缺失时回退到原始输出，不打断工作流。
 */
export const extractReviewResult = (output: string): string => {
  const startIdx = output.indexOf(REVIEW_DELIMITER_START)
  if (startIdx === -1) return output

  const afterStart = startIdx + REVIEW_DELIMITER_START.length
  const endIdx = output.indexOf(REVIEW_DELIMITER_END, afterStart)
  if (endIdx === -1) return output

  return output.slice(afterStart, endIdx).trim() || output
}

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
