import type { AgentRole } from "../agent/transcript/types.js"

/** ProtocolError 中 raw 字段最大保留长度 */
const RAW_MAX_LENGTH = 500

// ── Role-specific outcome schemas ──

export type ReviewVerdict = "pass" | "fail" | "needs_check"

export type RequestOption = {
  id: string
  label: string
  description?: string
}

export type RequestConfig = {
  question: string
  options?: RequestOption[]
  recommendation?: string
  allowFreeform: boolean
  inputHint?: string
}

export type ImplementerOutcome =
  | { outcome: "completed"; summary: string; report?: string }
  | { outcome: "needs_input"; summary: string; request: RequestConfig; report?: string }
  | { outcome: "failed"; summary: string; failure: { message: string }; report?: string }

export type ReviewerOutcome =
  | { outcome: "completed"; summary: string; review: { verdict: ReviewVerdict; cannotVerifySummary?: string }; report?: string }
  | { outcome: "needs_input"; summary: string; request: RequestConfig; report?: string }
  | { outcome: "failed"; summary: string; failure: { message: string }; report?: string }

export type AgentOutcome = ImplementerOutcome | ReviewerOutcome

export type ProtocolError = {
  kind: "protocol_error"
  reason: string
  /** 截断后的原始输出，最多 500 字符 */
  raw: string
}

export type ParseResult = AgentOutcome | ProtocolError

// ── Helpers ──

const truncate = (s: string): string => s.length <= RAW_MAX_LENGTH ? s : s.slice(0, RAW_MAX_LENGTH) + "…"

const protocolErr = (reason: string, raw: string): ProtocolError => ({
  kind: "protocol_error",
  reason,
  raw: truncate(raw),
})

/**
 * 从文本末尾提取 JSON 对象字符串。
 * 用于 agent 在 JSON 前输出说明文字的场景。
 * 规则：
 * - 拒绝 Markdown 代码块包裹的 JSON
 * - 正确跳过字符串内的 {} 字符
 * - 只接受紧邻末尾的最后一个 JSON 对象
 */
const extractTrailingJson = (text: string): string | null => {
  // 拒绝 Markdown 代码块（```json ... ``` 或 ``` ... ```）
  if (/```[\s\S]*```/.test(text)) return null

  const len = text.length
  // 从后往前找到 JSON 对象的结束位置（跳过尾部空白）
  let end = len - 1
  while (end >= 0 && /\s/.test(text[end])) end--
  if (end < 0 || text[end] !== "}") return null

  // 从 end 往前扫描，正确跳过字符串内容
  let depth = 0
  let inString = false
  let escape = false
  let jsonStart = -1
  for (let i = end; i >= 0; i--) {
    const ch = text[i]
    if (escape) { escape = false; continue }
    if (ch === "\\") { escape = true; continue }
    if (ch === '"') { inString = !inString; continue }
    if (inString) continue
    if (ch === "}") depth++
    else if (ch === "{") depth--
    if (depth === 0) {
      jsonStart = i
      break
    }
  }
  if (jsonStart < 0) return null

  const candidate = text.slice(jsonStart, end + 1)
  try {
    JSON.parse(candidate)
  } catch { return null }

  // 拒绝：JSON 之前还有其他完整的 JSON 对象（通过扫描配对的 {} 判断）
  const before = text.slice(0, jsonStart)
  let scanDepth = 0
  let scanInString = false
  let scanEscape = false
  for (let i = 0; i < before.length; i++) {
    const ch = before[i]
    if (scanEscape) { scanEscape = false; continue }
    if (ch === "\\") { scanEscape = true; continue }
    if (ch === '"') { scanInString = !scanInString; continue }
    if (scanInString) continue
    if (ch === "{") scanDepth++
    else if (ch === "}") {
      scanDepth--
      if (scanDepth === 0) {
        // 发现一个完整的 {} 对，检查它是否是合法 JSON 对象
        const prevJson = before.slice(before.lastIndexOf("{", i), i + 1)
        try { JSON.parse(prevJson); return null } catch { /* 非 JSON，继续 */ }
      }
    }
  }

  return candidate
}

// ── Parser ──

export const parseOutcome = (output: string, role: AgentRole): ParseResult => {
  const trimmed = output.trim()
  if (!trimmed) return protocolErr("Empty agent output", output)

  // 解析 JSON：支持纯 JSON 输出，也支持末尾 JSON（agent 可能在 JSON 前输出说明文字）
  let parsed: unknown
  let jsonStr = trimmed
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    // 整体解析失败，尝试从末尾提取 JSON（agent 可能在 JSON 前输出说明文字）
    const extracted = extractTrailingJson(trimmed)
    if (!extracted) {
      return protocolErr("输出中未找到合法 JSON", output)
    }
    jsonStr = extracted
    parsed = JSON.parse(extracted)
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return protocolErr("JSON 必须是对象", output)
  }

  return validateByRole(parsed as Record<string, unknown>, role)
}

// ── Validation ──

const extractReport = (obj: Record<string, unknown>): string | undefined =>
  typeof obj.report === "string" && obj.report.trim() ? obj.report : undefined

const validateByRole = (obj: Record<string, unknown>, role: AgentRole): ParseResult => {
  const outcome = obj.outcome
  if (typeof outcome !== "string") return protocolErr("缺少 outcome 字段", JSON.stringify(obj))

  const summary = typeof obj.summary === "string" ? obj.summary : undefined
  const report = extractReport(obj)

  switch (outcome) {
    case "completed": return { ...validateCompleted(obj, role, summary), report }
    case "needs_input": return { ...validateNeedsInput(obj, summary), report }
    case "failed": return { ...validateFailed(obj, summary), report }
    default: return protocolErr(`未知 outcome 值: ${outcome}`, JSON.stringify(obj))
  }
}

const validateCompleted = (
  obj: Record<string, unknown>,
  role: AgentRole,
  summary: string | undefined,
): ParseResult => {
  if (summary === undefined || !summary.trim()) {
    return protocolErr("completed 缺少 summary 字段", JSON.stringify(obj))
  }

  if (role === "reviewer") {
    const review = obj.review
    if (typeof review !== "object" || review === null || Array.isArray(review)) {
      return protocolErr("reviewer completed 缺少 review 字段", JSON.stringify(obj))
    }
    const r = review as Record<string, unknown>
    if (r.verdict !== "pass" && r.verdict !== "fail" && r.verdict !== "needs_check") {
      return protocolErr("review.verdict 必须是 pass / fail / needs_check", JSON.stringify(obj))
    }
    const cannotVerifySummary = typeof r.cannotVerifySummary === "string" && r.cannotVerifySummary.trim()
      ? r.cannotVerifySummary : undefined
    return { outcome: "completed", summary, review: { verdict: r.verdict, cannotVerifySummary } }
  }

  if (obj.review !== undefined) {
    return protocolErr("implementer 不能包含 review 字段", JSON.stringify(obj))
  }
  return { outcome: "completed", summary }
}

const validateNeedsInput = (
  obj: Record<string, unknown>,
  summary: string | undefined,
): ParseResult => {
  if (summary === undefined || !summary.trim()) {
    return protocolErr("needs_input 缺少 summary 字段", JSON.stringify(obj))
  }

  const request = obj.request
  if (typeof request !== "object" || request === null || Array.isArray(request)) {
    return protocolErr("缺少 request 字段", JSON.stringify(obj))
  }
  const r = request as Record<string, unknown>
  if (typeof r.question !== "string" || !r.question.trim()) {
    return protocolErr("request.question 必填", JSON.stringify(obj))
  }

  if (typeof r.allowFreeform !== "boolean") {
    return protocolErr("request.allowFreeform 必填", JSON.stringify(obj))
  }

  const reqConfig: RequestConfig = {
    question: r.question,
    allowFreeform: r.allowFreeform,
  }

  if (r.options !== undefined) {
    if (!Array.isArray(r.options) || r.options.length === 0) {
      return protocolErr("request.options 必须是非空数组", JSON.stringify(obj))
    }
    for (const o of r.options) {
      if (typeof o !== "object" || o === null || typeof (o as Record<string, unknown>).id !== "string" || typeof (o as Record<string, unknown>).label !== "string") {
        return protocolErr("request.options 条目必须有 id 和 label", JSON.stringify(obj))
      }
    }
    reqConfig.options = (r.options as Array<Record<string, unknown>>).map((o) => ({
      id: o.id as string,
      label: o.label as string,
      ...(typeof o.description === "string" ? { description: o.description } : {}),
    }))
  }
  if (typeof r.recommendation === "string" && r.recommendation.trim()) {
    reqConfig.recommendation = r.recommendation
  }
  if (typeof r.inputHint === "string" && r.inputHint.trim()) {
    reqConfig.inputHint = r.inputHint
  }

  return { outcome: "needs_input", summary, request: reqConfig }
}

const validateFailed = (
  obj: Record<string, unknown>,
  summary: string | undefined,
): ParseResult => {
  const failure = obj.failure
  if (typeof failure !== "object" || failure === null || Array.isArray(failure)) {
    return protocolErr("缺少 failure 字段", JSON.stringify(obj))
  }
  const f = failure as Record<string, unknown>
  // failure.message 缺失或为空 → 协议错误，不自动补默认值
  if (typeof f.message !== "string" || !f.message.trim()) {
    return protocolErr("failure.message 必填", JSON.stringify(obj))
  }
  if (summary === undefined || !summary.trim()) {
    return protocolErr("failed 缺少 summary 字段", JSON.stringify(obj))
  }
  return { outcome: "failed", summary, failure: { message: f.message } }
}

// ── Type guards ──

export const isProtocolError = (result: ParseResult): result is ProtocolError =>
  "kind" in result && result.kind === "protocol_error"

export const isAgentOutcome = (result: ParseResult): result is AgentOutcome =>
  !("kind" in result && result.kind === "protocol_error")
