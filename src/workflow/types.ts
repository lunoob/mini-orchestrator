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
  issueIndex: number
  needsCheckMode: NeedsCheckMode
  prompts: LoadedPrompts
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
  _specPath: string,
  issueIndex: number,
  issues: IssueConfig[],
) => {
  if (!runtime.implementerSession?.sessionId || !runtime.reviewerSession?.sessionId) {
    throw new Error("[Workflow] Cannot create checkpoint: session IDs are not available")
  }
  return {
    baseSha: runtime.baseSha,
    cannotVerifySummary: verdict.cannotVerifySummary,
    configPath,
    hasGit: runtime.hasGit,
    implementerSessionId: runtime.implementerSession.sessionId,
    maxReviewRounds: runtime.config.maxReviewRounds,
    projectDir: runtime.config.projectDir,
    reviewOutput,
    reviewerSessionId: runtime.reviewerSession.sessionId,
    reuseCurrentPane,
    round,
    sessionBaseUrl: runtime.sessionBaseUrl,
    currentIssueIndex: issueIndex,
    issues,
  }
}
