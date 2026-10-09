import type { AgentConfig } from "../types.js"

export const deduplicateAgentIntegrations = (agents: AgentConfig[]) => {
  const seenIntegrations = new Set<string>()

  return agents.filter((agent) => {
    const integration = agent.integrationAgent
    if (seenIntegrations.has(integration)) return false

    seenIntegrations.add(integration)
    return true
  })
}
