import type { ReviewVerdict } from "../lib/utils.js"
import type { WorkflowEventBus } from "../workflow/events.js"

export type NeedsCheckAction = "approve" | "revise" | "retry-review" | "abort"

export type NeedsCheckDecision = {
  action: NeedsCheckAction
  notes: string
}

export const buildNeedsCheckMessage = (round: number, verdict: ReviewVerdict, reviewOutput: string) => {
  const lines = [
    `Review round ${round}: REVIEW_NEEDS_CHECK`,
    "",
    "Reviewer 无法仅从 diff 验证部分项——这不等于实现失败。",
    "请人工核查后选择下一步。",
    "",
    "可选操作：",
    "  approve      — 人工确认通过，结束工作流",
    "  revise       — 补充说明后发回 implementer（需填写说明）",
    "  retry-review — 带补充上下文让 reviewer 重新审查同一轮（需填写说明，不计入新轮次）",
    "  abort        — 中止工作流",
  ]

  if (verdict.cannotVerifySummary) {
    lines.push("", "⚠️ Cannot verify:", verdict.cannotVerifySummary)
  }

  lines.push("", "--- Reviewer 完整输出 ---", reviewOutput.trim())

  return lines.join("\n")
}

/** 构建面板专用的 needs-check 摘要（不含完整 reviewOutput，避免面板溢出） */
export const buildNeedsCheckPanelPrompt = (
  round: number,
  verdict: ReviewVerdict,
  reviewerQuestion?: string,
) => {
  const lines = [
    `Review round ${round}: REVIEW_NEEDS_CHECK`,
    "Reviewer 无法仅从 diff 验证部分项。",
  ]

  if (reviewerQuestion) {
    lines.push("", `❓ Reviewer 提问: ${reviewerQuestion}`, "")
  }

  if (verdict.cannotVerifySummary) {
    lines.push(`⚠️ ${verdict.cannotVerifySummary}`)
  }

  lines.push("", "请核查后选择：[1]approve [2]revise [3]retry-review [4]abort")

  return lines.join("\n")
}

export const printNeedsCheckSummary = (round: number, verdict: ReviewVerdict, reviewOutput: string) => {
  console.log(`\n=== Needs Check — Round ${round} ===\n`)
  console.log(buildNeedsCheckMessage(round, verdict, reviewOutput))
  console.log("")
}

export const promptNeedsCheckInteractive = async (
  round: number,
  verdict: ReviewVerdict,
  reviewOutput: string,
  eventBus?: WorkflowEventBus,
  reviewerQuestion?: string,
): Promise<NeedsCheckDecision> => {
  printNeedsCheckSummary(round, verdict, reviewOutput)

  if (eventBus) {
    try {
      const result = await eventBus.requestInteraction({
        prompt: buildNeedsCheckPanelPrompt(round, verdict, reviewerQuestion),
        agent: "reviewer",
        actions: ["approve", "revise", "retry-review", "abort"],
        textRequiredFor: ["revise", "retry-review"],
        textInputPlaceholder: "说明（revise/retry-review 必填）",
      })
      const action = result.action as NeedsCheckAction
      if (action === "approve" || action === "abort") {
        return { action, notes: "" }
      }
      // revise/retry-review 必须有 notes，面板交互已通过文本输入捕获
      const notes = result.text ?? ""
      if (!notes) {
        // 面板未提供文本（异常情况），用日志提示而非 readline
        console.log(`[NeedsCheck] ${action} 需要说明文本，请重试。`)
        // 重新请求交互
        return promptNeedsCheckInteractive(round, verdict, reviewOutput, eventBus, reviewerQuestion)
      }
      return { action, notes }
    } catch {
      throw new Error("[NeedsCheck] No interaction handler available")
    }
  }

  throw new Error("[NeedsCheck] No interaction handler available")
}
