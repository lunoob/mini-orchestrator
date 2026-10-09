export const formatUpdateStart = (command: string) =>
  `[Agent] Running update: ${command}`

export const formatUpdateFailure = (code: number | null) =>
  `[Agent] Update failed (exit code ${code}), continuing anyway.`

export const formatIntegrationStart = (integration: string) =>
  `[Agent] Running herdr integration: herdr integration ${integration}`

export const formatIntegrationFailure = (code: number | null) =>
  `[Agent] Integration failed (exit code ${code}), continuing anyway.`

export const formatAgentStart = (name: string, command: string) =>
  `[Agent] Starting "${name}": ${command}`
