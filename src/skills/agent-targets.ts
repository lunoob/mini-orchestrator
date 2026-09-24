import os from "node:os"
import path from "node:path"

export const AGENT_TARGETS = [
  { id: "codex", label: "Codex", directory: [".codex", "skills"] },
  { id: "claude-code", label: "Claude Code", directory: [".claude", "skills"] },
  { id: "cursor", label: "Cursor", directory: [".cursor", "skills"] },
] as const

export type SkillAgent = (typeof AGENT_TARGETS)[number]["id"]

export const getAgentTargetDir = (agent: SkillAgent, homeDir = os.homedir()) => {
  const target = AGENT_TARGETS.find(item => item.id === agent)
  if (!target) throw new Error(`不支持的 agent：${agent}`)
  return path.join(homeDir, ...target.directory)
}

export const getAgentDisplayPath = (agent: SkillAgent, homeDir = os.homedir()) => {
  const relative = path.relative(homeDir, getAgentTargetDir(agent, homeDir))
  return `~/${relative.split(path.sep).join("/")}`
}
