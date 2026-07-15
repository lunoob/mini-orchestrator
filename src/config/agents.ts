import type { AgentConfig, AgentInputConfig } from "../types.js"

export type AgentDefinition = {
  agentReadyPattern: string
  /** 实际 CLI 可执行名，省略时与配置中的 agent 同名 */
  cli?: string
  supportsUpdate?: boolean
}

export const AGENT_DEFINITIONS: Record<string, AgentDefinition> = {
  claude: { agentReadyPattern: "Claude", supportsUpdate: true },
  codex: { agentReadyPattern: "Codex", supportsUpdate: true },
  cursor: { agentReadyPattern: "Cursor Agent", cli: "cursor-agent", supportsUpdate: true },
}

const buildCommand = (cli: string, model?: string) =>
  model ? `${cli} --model ${model}` : cli

export const resolveAgentConfig = (input: AgentInputConfig): AgentConfig => {
  const definition = AGENT_DEFINITIONS[input.agent]
  if (!definition) {
    throw new Error(
      `[Config] Unknown agent "${input.agent}" for "${input.name}". ` +
        `Supported: ${Object.keys(AGENT_DEFINITIONS).join(", ")}`,
    )
  }

  const cli = definition.cli ?? input.agent

  return {
    ...input,
    agentReadyPattern: definition.agentReadyPattern,
    command: buildCommand(cli, input.model),
    updateCommand: definition.supportsUpdate ? `${cli} update` : undefined,
  }
}
