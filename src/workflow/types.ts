import type { IssueConfig, LoadedPrompts, ParsedArgs, WorkflowConfig } from "../types.js"
import type { NeedsCheckMode } from "../review/needs-check.js"
import type { SessionClient } from "../session/client.js"
import type { WorkflowAgent } from "../session/workflow-agent.js"

export type WorkflowRuntime = {
  args: ParsedArgs
  baseSha: string | undefined
  config: WorkflowConfig
  sessionClient: SessionClient
  sessionBaseUrl: string
  hasGit: boolean
  implementerPane: string
  issueIndex: number
  needsCheckMode: NeedsCheckMode
  prompts: LoadedPrompts
  reviewerPane: string
  implementerSession?: WorkflowAgent
  reviewerSession?: WorkflowAgent
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
  implementerPane: runtime.implementerPane,
  maxReviewRounds: runtime.config.maxReviewRounds,
  projectDir: runtime.config.projectDir,
  reviewOutput,
  reviewerPane: runtime.reviewerPane,
  reuseCurrentPane,
  round,
  currentIssueIndex: issueIndex,
  issues,
})
