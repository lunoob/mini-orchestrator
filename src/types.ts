/** workflow 配置文件中 implementer / reviewer 的输入字段 */
export type AgentInputConfig = {
  agent: string
  /** codex / claude 的思考强度；cursor 请写入 model 后缀（如 composer-2.5-high） */
  effort?: string
  model?: string
  name: string
}

/** 由 agent + model 解析后的运行时 agent 配置 */
export type AgentConfig = AgentInputConfig & {
  command: string
}

/** Herdr pane-based agent 配置（旧 workflow 路径专用），在 AgentConfig 基础上补充 Herdr 特有字段 */
export type HerdrAgentConfig = AgentConfig & {
  agentReadyPattern: string
  integrationAgent: string
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

/** ready: 可开发；review: 已实现、待审查；finish: 已完成，workflow 会跳过 */
export type IssueState = "ready" | "review" | "finish"

export type IssueConfig = {
  title: string
  specPath: string
  /** 省略时视为 ready；loadConfig 会归一化为 ready、review 或 finish */
  state?: IssueState
}

export type WorkflowConfig = {
  implementer: AgentConfig
  maxReviewRounds: number
  projectDir: string
  prompts: PromptConfig
  reviewer: AgentConfig
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

export type PaneSplitResult = {
  id: string
  result: {
    pane: { pane_id: string }
    type: string
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
