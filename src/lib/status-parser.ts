import type { AgentRole } from "../agent/transcript/types.js"

/** Implementer 合法状态标记 */
export type ImplementerStatus = "IMPLEMENT_DONE" | "IMPLEMENT_ASK" | "IMPLEMENT_FAILED"
/** Reviewer 合法状态标记 */
export type ReviewerStatus = "REVIEW_PASS" | "REVIEW_NEEDS_CHECK" | "REVIEW_FAIL"
export type StatusKey = ImplementerStatus | ReviewerStatus

const IMPLEMENTER_KEYS = new Set<ImplementerStatus>(["IMPLEMENT_DONE", "IMPLEMENT_ASK", "IMPLEMENT_FAILED"])
const REVIEWER_KEYS = new Set<ReviewerStatus>(["REVIEW_PASS", "REVIEW_NEEDS_CHECK", "REVIEW_FAIL"])

/** 从 agent 输出中提取状态标记，非法标记视为不存在 */
export const extractStatus = (output: string, role: AgentRole): StatusKey | null => {
  const allowed = role === "reviewer" ? REVIEWER_KEYS : IMPLEMENTER_KEYS
  for (const line of output.split("\n")) {
    const m = /^STATUS:\s*(\w+)$/.exec(line.trim())
    if (!m) continue
    const key = m[1] as StatusKey
    if (allowed.has(key as never)) return key
  }
  return null
}

export type ParsedStatus = {
  status: StatusKey | null
  /** 去掉 STATUS 行后的正文（作为 revise 等流程的反馈文本） */
  body: string
}

export const parseStatus = (output: string, role: AgentRole): ParsedStatus => ({
  status: extractStatus(output, role),
  body: output
    .split("\n")
    .filter((line) => !/^STATUS:\s*\w+$/.test(line.trim()))
    .join("\n")
    .trim(),
})
