import type { AgentConfig } from "../types.js"

export const deduplicateAgentUpdates = (agents: AgentConfig[]) => {
  const seenCommands = new Set<string>()

  return agents.filter((agent) => {
    const command = agent.updateCommand
    if (!command || seenCommands.has(command)) return false

    seenCommands.add(command)
    return true
  })
}
