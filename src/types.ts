export type AgentConfig = {
  /** herdr wait output --match：等待启动输出中出现该文本后再发送首条 prompt */
  agentReadyPattern?: string
  command: string
  name: string
  /** 启动 agent 前先执行的 update 命令（如 "codex update"），
   *  仅在 workflow 首次启动 agent 前执行一次，避免 update 完成后 pane 关闭导致后续失败 */
  updateCommand?: string
}

export type PromptConfig = {
  controllerImplementer?: string
  controllerReReview?: string
  implement: string
  /** 自定义 implement 类 prompt 的输出格式 partial，省略时用默认 `prompts/partials/implement-output.md` */
  outputFormatImplement?: string
  /** 自定义 review 类 prompt 的输出格式 partial，省略时用默认 `prompts/partials/review-output.md` */
  outputFormatReview?: string
  postReviewCheck?: string
  reReview?: string
  review: string
  revise: string
}

export type SkillsConfig = {
  implement?: string[]
  revise?: string[]
}

export type IssueConfig = {
  title: string
  specPath: string
}

export type WorkflowConfig = {
  implementer: AgentConfig
  maxReviewRounds: number
  projectDir: string
  prompts: PromptConfig
  reviewer: AgentConfig
  skills?: SkillsConfig
  issues: IssueConfig[]
}

export type HerdrPaneInfo = {
  agent_status: string
  cwd: string
  focused: boolean
  foreground_cwd: string
  pane_id: string
  revision: number
  tab_id: string
  terminal_id: string
  workspace_id: string
}

export type AgentListEntry = HerdrPaneInfo & {
  agent: string
  name?: string
}

export type AgentListResult = {
  id: string
  result: {
    agents: AgentListEntry[]
    type: "agent_list"
  }
}

export type AgentStartResult = {
  id: string
  result: {
    agent: HerdrPaneInfo & { name: string }
    argv: string[]
    type: "agent_started"
  }
}

export type PaneCurrentResult = {
  id: string
  result: {
    pane: HerdrPaneInfo
    type: "pane_current"
  }
}

export type TaskRole = "implementer" | "reviewer"

export type TaskState = "pending" | "started" | "completed"

/** implementer 可回报的状态 */
export type ImplementerStatus = "IMPLEMENT_DONE" | "IMPLEMENT_ASK"

/** reviewer 可回报的状态 */
export type ReviewerStatus = "REVIEW_PASS" | "REVIEW_FAIL" | "REVIEW_NEEDS_CHECK"

export type TaskStatus = ImplementerStatus | ReviewerStatus

export type TaskFile = {
  runId: string
  role: TaskRole
  state: TaskState
  /** completed 时必须带 status */
  status?: TaskStatus
  createdAt: string
  updatedAt: string
}

export type ParsedArgs = Record<string, string>

export type LoadedPrompts = {
  controllerImplementer: string
  controllerReReview: string
  implement: string
  postReviewCheck: string
  reReview: string
  review: string
  revise: string
}
