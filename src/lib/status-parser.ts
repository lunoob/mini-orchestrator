import type { AgentRole, StatusParseResult } from "../agent/transcript/types.js"
import { IMPLEMENT_STATUSES, REVIEW_STATUSES } from "../agent/transcript/types.js"

/** 根据角色获取合法 STATUS 值 */
const legalStatuses = (role: AgentRole): readonly string[] =>
  role === "implementer" ? IMPLEMENT_STATUSES : REVIEW_STATUSES

/**
 * 严格解析 agent 最终输出中的 STATUS 标记。
 *
 * - 扫描整段输出中独立行 `STATUS: <值>`（允许前导空白）
 * - 必须恰好一个合法 STATUS；0 个或多个 → invalid_output
 * - 完整原始文本作为 output 字段保留
 */
export const parseAgentOutput = (output: string, role: AgentRole): StatusParseResult => {
  // 直接解析原始文本，不做 literal \n 转换，避免伪造非独占行
  const allowed = legalStatuses(role)

  // 匹配所有 STATUS 行：行首仅允许空格/Tab，行内空白也限于单行
  const statusPattern = /^[ \t]*STATUS:[ \t]*(.+)$/gm
  const matches = [...output.matchAll(statusPattern)]

  if (matches.length === 0) {
    return { status: "invalid_output", reason: "缺少 STATUS 标记", output }
  }

  if (matches.length > 1) {
    return { status: "invalid_output", reason: `多个 STATUS 标记（${matches.length} 个）`, output }
  }

  const statusValue = matches[0][1].trim()

  if (!(allowed as readonly string[]).includes(statusValue)) {
    return {
      status: "invalid_output",
      reason: `未知 STATUS 值: ${statusValue}（角色 ${role} 合法值: ${allowed.join(", ")}）`,
      output,
    }
  }

  // IMPLEMENT_ASK / REVIEW_NEEDS_CHECK → needs_input
  if (statusValue === "IMPLEMENT_ASK" || statusValue === "REVIEW_NEEDS_CHECK") {
    return { status: "needs_input", statusValue, output }
  }

  // 其余合法值 → completed
  return { status: "completed", statusValue, output }
}
