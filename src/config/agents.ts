import type { AgentConfig, AgentInputConfig } from "../types.js"
import type { AgentSessionHandle } from "../agent/transcript/types.js"

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

/** 构建 headless bootstrap 命令（不含 shell 重定向语法） */
const buildBootstrapArgv = (
  cli: string,
  agent: string,
  prompt: string,
  model?: string,
  effort?: string,
): string[] => {
  const args = [cli]

  // Claude/Cursor 用 -p，Codex 用 exec
  if (agent === "codex") {
    args.push("exec")
  } else {
    args.push("-p")
  }

  // prompt 作为独立 argv 参数，不含 shell quoting
  args.push(prompt)

  if (model) args.push("--model", model)

  if (effort) {
    if (agent === "codex") {
      args.push("-c", `model_reasoning_effort="${effort}"`)
    } else if (agent === "claude") {
      args.push("--effort", effort)
    }
  }

  return args
}

/**
 * 构建 headless bootstrap 命令字符串，末尾显式追加 2>/dev/null。
 *
 * 返回可直接用 shell 执行的完整命令字符串，argv 中的每个参数均经过 shell-safe 转义。
 * 与 spawn 不同：此函数生成的字符串经过 shell 解析，2>/dev/null 是 shell 重定向而非
 * 普通 argv 参数。
 */
export const buildBootstrapCommand = (config: AgentConfig, metaPrompt: string): string => {
  const definition = AGENT_DEFINITIONS[config.agent]
  if (!definition) {
    throw new Error(`[Config] Unknown agent "${config.agent}"`)
  }

  const cli = definition.cli ?? config.agent
  const argv = buildBootstrapArgv(cli, config.agent, metaPrompt, config.model, config.effort)

  // shell-safe 转义：引用含空格或特殊字符的参数
  const escaped = argv.map((arg) => {
    // 如果参数已经是双引号包裹的（如 -c 参数），去除内层引号再重新转义
    const clean = arg.replace(/^"|"$/g, "")
    if (clean.includes(" ") || clean.includes("'") || clean.includes('"')) {
      return `'${clean.replace(/'/g, "'\\''")}'`
    }
    return clean
  })

  // 显式追加 2>/dev/null，由 shell 解析为重定向
  return `${escaped.join(" ")} 2>/dev/null`
}

/** 构建 resume 时 pane 中使用的 CLI 参数（不含 CLI 名，由 splitCommand 处理后附加） */
export const buildResumeArgs = (config: AgentConfig, resumeId: string) => {
  const definition = AGENT_DEFINITIONS[config.agent]
  if (!definition) {
    throw new Error(`[Config] Unknown agent "${config.agent}"`)
  }

  const cli = definition.cli ?? config.agent
  const parts = [cli]

  // Claude/Cursor 用 --resume，Codex 用 resume 子命令
  if (config.agent === "codex") {
    parts.push("resume", resumeId)
  } else {
    parts.push("--resume", resumeId)
  }

  if (config.model) parts.push("--model", config.model)

  if (config.effort) {
    if (config.agent === "codex") {
      parts.push("-c", `model_reasoning_effort="${config.effort}"`)
    } else if (config.agent === "claude") {
      parts.push("--effort", config.effort)
    }
  }

  return parts.join(" ")
}

/** 从 headless bootstrap stdout 中严格解析 { resumeId, jsonl } */
export const parseBootstrapOutput = (
  stdout: string,
  provider: AgentSessionHandle["provider"],
): AgentSessionHandle | undefined => {
  const trimmed = stdout.trim()
  if (!trimmed) return undefined

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return undefined
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("resumeId" in parsed) ||
    !("jsonl" in parsed)
  ) {
    return undefined
  }

  const obj = parsed as Record<string, unknown>
  const resumeId = obj.resumeId
  const jsonl = obj.jsonl

  if (typeof resumeId !== "string" || !resumeId.trim()) return undefined
  if (typeof jsonl !== "string" || !jsonl.trim()) return undefined

  return { provider, resumeId, jsonl, offset: 0 }
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
