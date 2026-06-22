export const assertHerdrEnv = () => {
  if (process.env.HERDR_ENV === "1") return
  throw new Error("HERDR_ENV is not set to 1. Please run this inside a herdr pane.")
}

export const getErrorMessage = (error: unknown) => {
  if (error instanceof Error) return error.message
  return String(error)
}

export const hasStatus = (output: string, status: string) => output.includes(`STATUS: ${status}`)

export type ReviewVerdict = {
  hasBlockingIssues: boolean
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

export const parseReviewVerdict = (output: string): ReviewVerdict => {
  const explicitPass = hasStatus(output, "REVIEW_PASS")
  const explicitFail = hasStatus(output, "REVIEW_FAIL")

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

  const dualVerdictPass =
    specCompliant && !specFailed && qualityApproved && !qualityNeedsFix && !hasBlockingIssues

  const passed = explicitPass || (dualVerdictPass && !explicitFail)
  const failed = explicitFail || specFailed || qualityNeedsFix || hasBlockingIssues

  return {
    hasBlockingIssues,
    passed: passed && !failed,
    qualityApproved: qualityApproved ? true : qualityNeedsFix ? false : null,
    specCompliant: specCompliant ? true : specFailed ? false : null,
  }
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
