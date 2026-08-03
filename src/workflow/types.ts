import type { LoadedPrompts, ParsedArgs, WorkflowConfig } from "../types.js"
import type { AgentSessionHandle } from "../agent/transcript/types.js"
import type { WorkflowEventBus } from "./events.js"

export type WorkflowRuntime = {
  args: ParsedArgs
  /** 当前 review 基线，随 issue 完成而推进 */
  baseSha: string | undefined
  config: WorkflowConfig
  configPath: string
  eventBus: WorkflowEventBus
  /** Final Reviewer / Final Fixer 的 pane 与 session，仅在 final 阶段按需启动 */
  finalFixerPane: string
  finalFixerSession?: AgentSessionHandle
  finalReviewerPane: string
  finalReviewerSession?: AgentSessionHandle
  hasGit: boolean
  implementerPane: string
  implementerSession?: AgentSessionHandle
  issueIndex: number
  prompts: LoadedPrompts
  reviewerPane: string
  reviewerSession?: AgentSessionHandle
  /** workflow 起始基线：final gate 全量 diff 从它开始，不被 advanceBaseline 推进 */
  startBaseSha: string | undefined
}

export type ReviewLoopOptions = {
  controllerReviewNotes?: string
  lastReviewOutput?: string
}

export type NeedsCheckOutcome =
  | { type: "approved" }
  | { type: "continue_round" }
  | { type: "retry_same_round"; controllerNotes: string; lastReviewOutput: string }

export type PostReviewStatus = "REVIEW_PASS" | "REVIEW_NEEDS_CHECK"

export type ReviewContext = {
  baseSha: string
  diffFile: string | undefined
  headSha: string
}
