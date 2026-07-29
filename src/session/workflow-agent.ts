import { randomUUID } from "node:crypto"

import type { AgentConfig } from "../types.js"
import type { SessionRole } from "./types.js"
import { createRunnerSupervisor, type RunnerHandle } from "./runner-supervisor.js"
import type { SessionClient } from "./client.js"
import { waitForTurn } from "./turn-wait.js"

export type WorkflowAgent = RunnerHandle & {
  sendTaskAndWait: (prompt: string) => Promise<string>
  /** The turnId of the most recent sendTaskAndWait call */
  lastTurnId: () => string | undefined
}

type WorkflowAgentOptions = {
  agent: AgentConfig
  baseUrl: string
  client: SessionClient
  projectDir: string
  runDirectory: string
  role: SessionRole
}

export const startWorkflowAgent = async (options: WorkflowAgentOptions): Promise<WorkflowAgent> => {
  const supported = new Set(["claude", "codex", "cursor"])
  if (!supported.has(options.agent.agent)) throw new Error(`[Session] Unsupported runner agent: ${options.agent.agent}`)
  const session = await options.client.create({
    agent: options.agent,
    role: options.role,
    runDirectory: options.runDirectory,
    workspace: options.projectDir,
  })
  const runnerToken = options.client.getRunnerToken(session.id)
  if (!runnerToken) throw new Error(`[Session] Missing runner capability for ${session.id}`)
  const supervisor = createRunnerSupervisor({
    agent: options.agent,
    baseUrl: options.baseUrl,
    projectDir: options.projectDir,
    runDirectory: options.runDirectory,
    runnerToken,
    sessionClient: options.client,
    sessionId: session.id,
  })
  const handle = await supervisor.start()

  let lastTurnId: string | undefined

  const sendTaskAndWait = async (prompt: string) => {
    const { turnId } = await options.client.sendMessage(session.id, { content: prompt, eventId: randomUUID() })
    lastTurnId = turnId
    const result = await waitForTurn(options.client, session.id, turnId)
    if (result.turn.status !== "completed") {
      throw new Error(`[Session] Turn ${turnId} ended with status ${result.turn.status}${result.turn.error ? `: ${result.turn.error}` : ""}`)
    }
    return result.output?.content ?? result.turn.outputText ?? ""
  }

  return { ...handle, lastTurnId: () => lastTurnId, sendTaskAndWait }
}
