export type AgentConfig = {
  command: string
  name: string
}

export type PromptConfig = {
  controllerImplementer?: string
  controllerReReview?: string
  implement: string
  review: string
  revise: string
}

export type SkillsConfig = {
  implement?: string[]
  revise?: string[]
}

export type WorkflowConfig = {
  implementer: AgentConfig
  maxReviewRounds: number
  projectDir: string
  prompts: PromptConfig
  reviewer: AgentConfig
  skills?: SkillsConfig
  specPath: string
}

export type PaneIdResult = {
  result: {
    pane: {
      pane_id: string
    }
  }
}

export type ParsedArgs = Record<string, string>

export type LoadedPrompts = {
  controllerImplementer: string
  controllerReReview: string
  implement: string
  review: string
  revise: string
}
