import { spawn } from "node:child_process"

import type { AgentConfig, AgentListResult, AgentStartResult } from "../types.js"
import { splitCommand } from "../lib/utils.js"
import { runHerdr, tryRunHerdr } from "./subprocess.js"
import { AGENT_COMPLETE_STATUSES, isAgentCompleteStatus, readAgentStatus, waitForAgentStatus } from "./status-wait.js"

const DEFAULT_READY_TIMEOUT_MS = 120_000
const DEFAULT_OUTPUT_MATCH_TIMEOUT_MS = 60_000
const DEFAULT_WORKING_TIMEOUT_MS = 60_000
const IDLE_TIMEOUT_MS = 1_800_000

export type AgentWaitOptions = {
  agentReadyPattern?: string
  outputMatchTimeoutMs?: number
  readyTimeoutMs?: number
  workingTimeoutMs?: number
}

export const listAgentNames = async () => {
  const output = await runHerdr(["agent", "list"])
  const parsed = JSON.parse(output) as AgentListResult
  const names = new Set<string>()
  for (const entry of parsed.result.agents) {
    if (entry.name) names.add(entry.name)
  }
  return names
}

const generateUniqueAgentName = (baseName: string, takenNames: ReadonlySet<string>) => {
  if (!takenNames.has(baseName)) return baseName

  let suffix = 1
  while (takenNames.has(`${baseName}-${suffix}`)) suffix++
  return `${baseName}-${suffix}`
}

export const resolveUniqueAgentName = async (baseName: string) => {
  const takenNames = await listAgentNames()
  return generateUniqueAgentName(baseName, takenNames)
}

export type StartAgentOptions = {
  ensureUniqueName?: boolean
}

const startAgentWithName = async (projectDir: string, agent: AgentConfig, name: string) => {
  const output = await runHerdr([
    "agent",
    "start",
    name,
    "--cwd",
    projectDir,
    "--no-focus",
    "--",
    ...splitCommand(agent.command),
  ])
  const parsed = JSON.parse(output) as AgentStartResult
  return parsed.result.agent.pane_id
}

export const startAgent = async (
  projectDir: string,
  agent: AgentConfig,
  options: StartAgentOptions = {},
) => {
  let name = agent.name
  if (options.ensureUniqueName) {
    name = await resolveUniqueAgentName(agent.name)
    if (name !== agent.name) {
      console.log(`[Agent] Name "${agent.name}" is taken; using "${name}" instead.`)
    }
  }

  return startAgentWithName(projectDir, agent, name)
}

export const waitForAgentReady = async (paneId: string, options: AgentWaitOptions = {}) => {
  const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS
  const outputMatchTimeoutMs = options.outputMatchTimeoutMs ?? DEFAULT_OUTPUT_MATCH_TIMEOUT_MS

  await waitForAgentStatus(paneId, "idle", readyTimeoutMs)

  if (!options.agentReadyPattern) return

  await runHerdr([
    "wait",
    "output",
    paneId,
    "--match",
    options.agentReadyPattern,
    "--source",
    "recent-unwrapped",
    "--timeout",
    String(outputMatchTimeoutMs),
  ])
}

export const sendTask = async (paneId: string, prompt: string) => {
  await runHerdr(["agent", "send", paneId, prompt])
  await runHerdr(["pane", "send-keys", paneId, "enter"])
}

export const waitForIdle = async (paneId: string): Promise<void> => {
  await waitForAgentStatus(paneId, AGENT_COMPLETE_STATUSES, IDLE_TIMEOUT_MS)

  await new Promise(resolve => setTimeout(resolve, 2000))

  const status = await readAgentStatus(paneId)
  if (isAgentCompleteStatus(status)) return

  return waitForIdle(paneId)
}

const waitForWorkingAfterSend = async (
  paneId: string,
  prompt: string,
  options: AgentWaitOptions,
) => {
  const workingTimeoutMs = options.workingTimeoutMs ?? DEFAULT_WORKING_TIMEOUT_MS

  try {
    await waitForAgentStatus(paneId, "working", workingTimeoutMs)
    return
  } catch {
    // fall through to retry
  }

  console.log(`[Agent] Pane ${paneId} did not enter working; retrying after ready wait...`)
  await waitForAgentReady(paneId, options)
  await sendTask(paneId, prompt)

  try {
    await waitForAgentStatus(paneId, "working", workingTimeoutMs)
  } catch {
    throw new Error(
      `[Agent] Pane ${paneId} did not enter working after send — prompt likely lost. ` +
        "Check agentReadyPattern or agent startup.",
    )
  }
}

export const sendTaskAndWait = async (
  paneId: string,
  prompt: string,
  options: AgentWaitOptions = {},
): Promise<string> => {
  await sendTask(paneId, prompt)
  await waitForWorkingAfterSend(paneId, prompt, options)
  await waitForIdle(paneId)

  return readAgentOutput(paneId, 280)
}

export const agentWaitOptions = (agent: AgentConfig): AgentWaitOptions => ({
  agentReadyPattern: agent.agentReadyPattern,
})

export const runAgentUpdate = async (
  projectDir: string,
  agent: AgentConfig,
): Promise<boolean> => {
  if (!agent.updateCommand) return true

  console.log(`[Agent] Running update for "${agent.name}": ${agent.updateCommand}`)

  const [cmd, ...args] = splitCommand(agent.updateCommand)
  const { code } = await new Promise<{ code: number | null }>((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: projectDir,
      env: process.env,
      stdio: "inherit",
    })
    child.on("error", reject)
    child.on("close", resolve)
  })

  if (code !== 0) {
    console.warn(`[Agent] Update for "${agent.name}" failed (exit code ${code}), continuing anyway.`)
    return false
  }
  return true
}

export const runAgentIntegration = async (agent: AgentConfig): Promise<boolean> => {
  console.log(
    `[Agent] Running herdr integration for "${agent.name}": herdr integration ${agent.integrationAgent}`,
  )

  const { code } = await tryRunHerdr(["integration", "install", agent.integrationAgent])
  if (code !== 0) {
    console.warn(
      `[Agent] Integration for "${agent.name}" failed (exit code ${code}), continuing anyway.`,
    )
    return false
  }
  return true
}

export const stopAgent = async (paneId: string) => {
  await runHerdr(["pane", "close", paneId])
}

export const readAgentOutput = async (paneId: string, lines: number) =>
  runHerdr([
    "agent",
    "read",
    paneId,
    "--source",
    "recent-unwrapped",
    "--lines",
    String(lines),
  ])

export const readAgentOutputWithRetry = async (
  paneId: string,
  lines: number,
  isValid: (output: string) => boolean,
  maxRetries = 3,
  retryIntervalMs = 1500,
  readFn: (paneId: string, lines: number) => Promise<string> = readAgentOutput,
): Promise<string> => {
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    const output = await readFn(paneId, lines)
    if (isValid(output)) return output

    if (attempt < maxRetries - 1) {
      console.log(`[Agent] Output not synced on attempt ${attempt + 1}/${maxRetries} for pane ${paneId}, retrying in ${retryIntervalMs}ms...`)
      await new Promise(resolve => setTimeout(resolve, retryIntervalMs))
    }
  }

  throw new Error(
    `[Agent] Task completed but output not synced after ${maxRetries} retries for pane ${paneId}. ` +
    "Output may not have synced to terminal.",
  )
}
