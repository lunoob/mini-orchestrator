import { spawn } from "node:child_process"

import type { AgentConfig, AgentListResult, AgentStartResult, PaneCurrentResult } from "./types.js"
import { splitCommand } from "./utils.js"

const DEFAULT_READY_TIMEOUT_MS = 120_000
const DEFAULT_OUTPUT_MATCH_TIMEOUT_MS = 60_000
const DEFAULT_WORKING_TIMEOUT_MS = 60_000
const IDLE_TIMEOUT_MS = 1_800_000
const DELAY_MS = 800

export type AgentWaitOptions = {
  agentReadyPattern?: string
  outputMatchTimeoutMs?: number
  readyTimeoutMs?: number
  workingTimeoutMs?: number
}

const run = async (command: string, args: string[]) => {
  // avoid command too fast
  await new Promise(resolve => setTimeout(resolve, DELAY_MS))
  return new Promise<{ code: number | null; stderr: string; stdout: string }>((resolve, reject) => {
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
}

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

export const listAgentNames = async () => {
  const output = await runHerdr(["agent", "list"])
  const parsed = JSON.parse(output) as AgentListResult
  const names = new Set<string>()
  for (const entry of parsed.result.agents) {
    if (entry.name) names.add(entry.name)
  }
  return names
}

export const generateUniqueAgentName = (baseName: string, takenNames: ReadonlySet<string>) => {
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
      console.log(`Agent name "${agent.name}" is taken; using "${name}" instead.`)
    }
  }

  return startAgentWithName(projectDir, agent, name)
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

export const waitForIdle = async (paneId: string): Promise<void> => {
  // 1. 使用 herdr 内置等待机制等待 idle（保留原逻辑）
  await runHerdr([
    "agent",
    "wait",
    paneId,
    "--status",
    "idle",
    "--timeout",
    String(IDLE_TIMEOUT_MS),
  ])

  // 2. 再等 2 秒，避免检测到瞬时状态变化
  await new Promise(resolve => setTimeout(resolve, 2000))

  // 3. 调用 herdr agent list 获取当前实际状态，验证是否真的 idle
  const output = await runHerdr(["agent", "list"])
  const parsed = JSON.parse(output) as AgentListResult
  const agent = parsed.result.agents.find(a => a.pane_id === paneId)

  if (agent?.agent_status === "idle") return

  // 4. 并非真正 idle——递归重试
  return waitForIdle(paneId)
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
