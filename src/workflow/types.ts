import type { LoadedPrompts, ParsedArgs, WorkflowConfig } from "../types.js"
import type { AgentSessionHandle } from "../agent/transcript/types.js"
import type { WorkflowEventBus } from "./events.js"

export type WorkflowRuntime = {
  args: ParsedArgs
  baseSha: string | undefined
  config: WorkflowConfig
  configPath: string
  eventBus: WorkflowEventBus
  hasGit: boolean
  implementerPane: string
  implementerSession?: AgentSessionHandle
  issueIndex: number
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
