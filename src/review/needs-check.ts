import { createInterface } from "node:readline/promises"
import { stdin as input, stdout as output } from "node:process"

import type { NeedsCheckCheckpointInput } from "./checkpoint.js"
import { writeNeedsCheckCheckpoint } from "./checkpoint.js"
import type { ParsedArgs } from "../types.js"
import type { ReviewVerdict } from "../lib/utils.js"

export type NeedsCheckAction = "approve" | "revise" | "retry-review" | "abort"

export type NeedsCheckMode = "interactive" | "llm"

export type NeedsCheckDecision = {
  action: NeedsCheckAction
  notes: string
}

const VALID_ACTIONS = new Set<string>(["approve", "revise", "retry-review", "abort"])

export type NeedsCheckNotificationContext = {
  role: string
  provider: string
  paneId: string
  reason: string
  turnId?: string
  /** 明确的干预类型，避免从本地化原因文本推断 */
  interventionType: "needs_input" | "invalid_output"
  /** checkpoint 路径，供通知包含恢复指引 */
  checkpointPath?: string
}

export class NeedsCheckPauseError extends Error {
  checkpointPath: string
  notificationContext?: NeedsCheckNotificationContext

  constructor(checkpointPath: string, notificationContext?: NeedsCheckNotificationContext) {
    super("Workflow paused: awaiting needs-check decision (LLM mode)")
    this.name = "NeedsCheckPauseError"
    this.checkpointPath = checkpointPath
    this.notificationContext = notificationContext
  }
}

export const parseNeedsCheckMode = (args: ParsedArgs): NeedsCheckMode =>
  args["needs-check-mode"] === "llm" ? "llm" : "interactive"

export const parseNeedsCheckAction = (value: string | undefined): NeedsCheckAction => {
  if (!value || !VALID_ACTIONS.has(value)) {
    throw new Error(
      `[NeedsCheck] Invalid --needs-check-action: ${value ?? "(missing)"}. Expected approve | revise | retry-review | abort`,
    )
  }

  return value as NeedsCheckAction
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

export const printNeedsCheckSummary = (round: number, verdict: ReviewVerdict, reviewOutput: string) => {
  console.log(`\n=== Needs Check — Round ${round} ===\n`)
  console.log(buildNeedsCheckMessage(round, verdict, reviewOutput))
  console.log("")
}

const promptChoice = async (): Promise<NeedsCheckAction> => {
  const rl = createInterface({ input, output })

  try {
    while (true) {
      const answer = (await rl.question("请选择 [approve / revise / retry-review / abort]: "))
        .trim()
        .toLowerCase()

      if (VALID_ACTIONS.has(answer)) return answer as NeedsCheckAction
      console.log("[NeedsCheck] 无效输入，请输入：approve / revise / retry-review / abort")
    }
  } finally {
    rl.close()
  }
}

const promptNotes = async (action: NeedsCheckAction) => {
  const rl = createInterface({ input, output })
  const hint =
    action === "revise"
      ? "发给 implementer 的说明（必填）： "
      : "发给 reviewer 的补充核查结果（必填）： "

  try {
    while (true) {
      const notes = (await rl.question(hint)).trim()
      if (notes) return notes
      console.log("[NeedsCheck] 说明不能为空，请重新输入。")
    }
  } finally {
    rl.close()
  }
}

export const promptNeedsCheckInteractive = async (
  round: number,
  verdict: ReviewVerdict,
  reviewOutput: string,
): Promise<NeedsCheckDecision> => {
  printNeedsCheckSummary(round, verdict, reviewOutput)

  const action = await promptChoice()

  if (action === "approve" || action === "abort") {
    return { action, notes: "" }
  }

  const notes = await promptNotes(action)
  return { action, notes }
}

export const pauseForLlmNeedsCheck = async (
  dir: string,
  checkpointInput: NeedsCheckCheckpointInput,
  round: number,
  verdict: ReviewVerdict,
  reviewOutput: string,
  notificationContext?: NeedsCheckNotificationContext,
) => {
  const checkpointPath = await writeNeedsCheckCheckpoint(dir, checkpointInput)

  // 将 checkpointPath 写回通知上下文，供主入口生成完整恢复指引
  const mergedContext: NeedsCheckNotificationContext | undefined = notificationContext
    ? { ...notificationContext, checkpointPath }
    : undefined

  printNeedsCheckSummary(round, verdict, reviewOutput)

  console.log("STATUS: ORCHESTRATOR_NEEDS_CHECK")
  console.log(`CHECKPOINT: ${checkpointPath}`)
  console.log("")
  console.log("[NeedsCheck] （LLM 模式：脚本已暂停。请外层 agent 询问用户后，使用 --resume-from 继续。）")

  throw new NeedsCheckPauseError(checkpointPath, mergedContext)
}

export const decisionFromArgs = (args: ParsedArgs): NeedsCheckDecision | undefined => {
  if (!args["needs-check-action"]) return undefined

  const action = parseNeedsCheckAction(args["needs-check-action"])
  const notes = (args["needs-check-notes"] ?? "").trim()

  if ((action === "revise" || action === "retry-review") && !notes) {
    throw new Error(`[NeedsCheck] --needs-check-notes is required for action: ${action}`)
  }

  return { action, notes }
}

export const resolveNeedsCheckDecision = async (
  args: ParsedArgs,
  mode: NeedsCheckMode,
  round: number,
  verdict: ReviewVerdict,
  reviewOutput: string,
  checkpointInput: NeedsCheckCheckpointInput,
  dir: string,
  notificationContext?: NeedsCheckNotificationContext,
): Promise<NeedsCheckDecision> => {
  const fromArgs = decisionFromArgs(args)
  if (fromArgs) return fromArgs

  if (mode === "llm") {
    await pauseForLlmNeedsCheck(dir, checkpointInput, round, verdict, reviewOutput, notificationContext)
  }

  return promptNeedsCheckInteractive(round, verdict, reviewOutput)
}
