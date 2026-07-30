import type { IssueConfig, LoadedPrompts, ParsedArgs, WorkflowConfig } from "../types.js"
import type { NeedsCheckMode } from "../review/needs-check.js"
import type { AgentSessionHandle } from "../agent/transcript/types.js"

export type WorkflowRuntime = {
  args: ParsedArgs
  baseSha: string | undefined
  config: WorkflowConfig
  /** 当前 workflow 配置文件路径，供 checkpoint 恢复使用 */
  configPath: string
  hasGit: boolean
  implementerPane: string
  implementerSession?: AgentSessionHandle
  issueIndex: number
  needsCheckMode: NeedsCheckMode
  prompts: LoadedPrompts
  reviewerPane: string
  reviewerSession?: AgentSessionHandle
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

export const buildCheckpointInput = (
  runtime: WorkflowRuntime,
  configPath: string,
  round: number,
  reviewOutput: string,
  verdict: import("../lib/utils.js").ReviewVerdict,
  reuseCurrentPane: boolean,
  specPath: string,
  issueIndex: number,
  issues: IssueConfig[],
) => ({
  baseSha: runtime.baseSha,
  cannotVerifySummary: verdict.cannotVerifySummary,
  configPath,
  hasGit: runtime.hasGit,
  // 不保存 pane ID（已关闭时不可靠），仅保存 session handle 用于 resumeId 重建
  implementerPane: "",
  implementerSession: runtime.implementerSession,
  maxReviewRounds: runtime.config.maxReviewRounds,
  projectDir: runtime.config.projectDir,
  reviewOutput,
  reviewerPane: "",
  reviewerSession: runtime.reviewerSession,
  reuseCurrentPane,
  round,
  currentIssueIndex: issueIndex,
  issues,
})
