import { spawn } from "node:child_process"

import type { AgentConfig, AgentStartResult, PaneCurrentResult } from "./types.js"
import { splitCommand } from "./utils.js"

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

const run = (command: string, args: string[]) =>
  new Promise<{ code: number | null; stderr: string; stdout: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString()
    })
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString()
    })

    child.on("error", reject)
    child.on("close", (code) => resolve({ code, stdout, stderr }))
  })

export const runHerdr = async (args: string[]) => {
  const { code, stderr, stdout } = await run("herdr", args)
  if (code === 0) return stdout.trim()

  throw new Error(stderr.trim() || `herdr ${args.join(" ")} failed with code ${code}`)
}

const tryRunHerdr = async (args: string[]) => {
  const { code, stderr, stdout } = await run("herdr", args)
  return { code, stderr: stderr.trim(), stdout: stdout.trim() }
}

const tryWaitStatus = async (paneId: string, status: string, timeoutMs: number) => {
  const { code } = await tryRunHerdr([
    "agent",
    "wait",
    paneId,
    "--status",
    status,
    "--timeout",
    String(timeoutMs),
  ])
  return code === 0
}

export const getCurrentPane = async () => {
  const output = await runHerdr(["pane", "current"])
  const parsed = JSON.parse(output) as PaneCurrentResult
  return parsed.result.pane.pane_id
}

export const startAgent = async (projectDir: string, agent: AgentConfig) => {
  const output = await runHerdr([
    "agent",
    "start",
    agent.name,
    "--cwd",
    projectDir,
    "--no-focus",
    "--",
    ...splitCommand(agent.command),
  ])
  const parsed = JSON.parse(output) as AgentStartResult
  return parsed.result.agent.pane_id
}

export const waitForAgentReady = async (paneId: string, options: AgentWaitOptions = {}) => {
  const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS
  const outputMatchTimeoutMs = options.outputMatchTimeoutMs ?? DEFAULT_OUTPUT_MATCH_TIMEOUT_MS

  await runHerdr([
    "agent",
    "wait",
    paneId,
    "--status",
    "idle",
    "--timeout",
    String(readyTimeoutMs),
  ])

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

export const waitForIdle = async (paneId: string) => {
  await runHerdr(["agent", "wait", paneId, "--status", "idle", "--timeout", String(IDLE_TIMEOUT_MS)])
}

const waitForWorkingAfterSend = async (
  paneId: string,
  prompt: string,
  options: AgentWaitOptions,
) => {
  const workingTimeoutMs = options.workingTimeoutMs ?? DEFAULT_WORKING_TIMEOUT_MS

  if (await tryWaitStatus(paneId, "working", workingTimeoutMs)) return

  console.log(`Agent ${paneId} did not enter working; retrying after ready wait...`)
  await waitForAgentReady(paneId, options)
  await sendTask(paneId, prompt)

  if (await tryWaitStatus(paneId, "working", workingTimeoutMs)) return

  throw new Error(
    `Agent ${paneId} did not enter working after send — prompt likely lost. ` +
      "Check agentReadyPattern or agent startup.",
  )
}

export const sendTaskAndWait = async (
  paneId: string,
  prompt: string,
  options: AgentWaitOptions = {},
) => {
  await sendTask(paneId, prompt)
  await waitForWorkingAfterSend(paneId, prompt, options)
  await waitForIdle(paneId)
}

export const agentWaitOptions = (agent: AgentConfig): AgentWaitOptions => ({
  agentReadyPattern: agent.agentReadyPattern,
})

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
