import type { AgentConfig, AgentInputConfig } from "../types.js"

export type AgentDefinition = {
  agentReadyPattern: string
  /** 实际 CLI 可执行名，省略时与配置中的 agent 同名 */
  cli?: string
  /** herdr integration 子命令参数，省略时与配置中的 agent 同名 */
  integrationAgent?: string
  supportsUpdate?: boolean
}

export const AGENT_DEFINITIONS: Record<string, AgentDefinition> = {
  claude: { agentReadyPattern: "Claude", supportsUpdate: true },
  codex: { agentReadyPattern: "Codex", supportsUpdate: true },
  cursor: { agentReadyPattern: "Cursor Agent", cli: "cursor-agent", supportsUpdate: true },
}

const CODEX_EFFORT_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh"] as const
const CLAUDE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const

const validateEffort = (agent: string, effort: string, role: string) => {
  if (agent === "cursor") {
    throw new Error(
      `[Config] ${role}.effort is not supported for cursor; ` +
        `use model suffix instead (e.g. composer-2.5-high).`,
    )
  }

  const allowed =
    agent === "codex"
      ? CODEX_EFFORT_LEVELS
      : agent === "claude"
        ? CLAUDE_EFFORT_LEVELS
        : undefined

  if (!allowed || !(allowed as readonly string[]).includes(effort)) {
    throw new Error(
      `[Config] Invalid ${role}.effort "${effort}" for agent "${agent}". ` +
        `Supported: ${allowed?.join(", ") ?? "none"}`,
    )
  }
}

const buildCommand = (cli: string, agent: string, model?: string, effort?: string) => {
  const parts = [cli]
  if (model) parts.push("--model", model)

  if (!effort) return parts.join(" ")

  if (agent === "codex") {
    parts.push("-c", `model_reasoning_effort="${effort}"`)
  } else if (agent === "claude") {
    parts.push("--effort", effort)
  }

  return parts.join(" ")
}

export const resolveAgentConfig = (input: AgentInputConfig): AgentConfig => {
  const definition = AGENT_DEFINITIONS[input.agent]
  if (!definition) {
    throw new Error(
      `[Config] Unknown agent "${input.agent}" for "${input.name}". ` +
        `Supported: ${Object.keys(AGENT_DEFINITIONS).join(", ")}`,
    )
  }

  if (input.effort) validateEffort(input.agent, input.effort, input.name)

  const cli = definition.cli ?? input.agent
  const integrationAgent = definition.integrationAgent ?? input.agent

  return {
    ...input,
    agentReadyPattern: definition.agentReadyPattern,
    command: buildCommand(cli, input.agent, input.model, input.effort),
    integrationAgent,
    updateCommand: definition.supportsUpdate ? `${cli} update` : undefined,
  }
}
