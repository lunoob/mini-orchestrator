import { spawn } from "node:child_process"

import type { AgentConfig, AgentListEntry, AgentListResult, AgentStartResult, PaneCurrentResult } from "./types.js"
import { splitCommand } from "./utils.js"

const DEFAULT_READY_TIMEOUT_MS = 120_000
const DEFAULT_OUTPUT_MATCH_TIMEOUT_MS = 60_000
const DEFAULT_WORKING_TIMEOUT_MS = 60_000
const IDLE_TIMEOUT_MS = 1_800_000
const POLL_INTERVAL_MS = 5_000
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

  throw new Error(`[Agent] ${stderr.trim() || `herdr ${args.join(" ")} failed with code ${code}`}`)
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
      console.log(`[Agent] Name "${agent.name}" is taken; using "${name}" instead.`)
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

type AgentGetResult = {
  id: string
  result: {
    agent: AgentListEntry
    type: "agent_get"
  }
}

/**
 * 轮询 herdr agent get 获取语义状态，等待 agent 进入 idle。
 * 替代事件驱动的 waitForIdle（herdr agent wait 在后台 pane 不推送事件）。
 * 返回时已读取完整输出，调用方无需再调 readAgentOutput。
 */
const waitForIdleByPolling = async (paneId: string): Promise<string> => {
  const deadline = Date.now() + IDLE_TIMEOUT_MS
  let lastStatus = "unknown"

  while (Date.now() < deadline) {
    const output = await runHerdr(["agent", "get", paneId])
    const parsed = JSON.parse(output) as AgentGetResult
    lastStatus = parsed.result.agent.agent_status

    if (lastStatus === "idle") {
      return readAgentOutput(paneId, 280)
    }

    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
  }

  throw new Error(
    `[Agent] Pane ${paneId} did not complete within ${IDLE_TIMEOUT_MS / 1000}s timeout ` +
      `(last status: ${lastStatus}).` +
      `\nLast output:\n${(await readAgentOutput(paneId, 10)).slice(0, 500)}`,
  )
}

const waitForWorkingAfterSend = async (
  paneId: string,
  prompt: string,
  options: AgentWaitOptions,
) => {
  const workingTimeoutMs = options.workingTimeoutMs ?? DEFAULT_WORKING_TIMEOUT_MS

  if (await tryWaitStatus(paneId, "working", workingTimeoutMs)) return

  console.log(`[Agent] Pane ${paneId} did not enter working; retrying after ready wait...`)
  await waitForAgentReady(paneId, options)
  await sendTask(paneId, prompt)

  if (await tryWaitStatus(paneId, "working", workingTimeoutMs)) return

  throw new Error(
    `[Agent] Pane ${paneId} did not enter working after send — prompt likely lost. ` +
      "Check agentReadyPattern or agent startup.",
  )
}

export const sendTaskAndWait = async (
  paneId: string,
  prompt: string,
  options: AgentWaitOptions = {},
): Promise<string> => {
  await sendTask(paneId, prompt)
  await waitForWorkingAfterSend(paneId, prompt, options)

  // 轮询等待 agent 完成，不依赖 herdr 事件推送（后台 pane 不触发事件）
  return waitForIdleByPolling(paneId)
}

export const agentWaitOptions = (agent: AgentConfig): AgentWaitOptions => ({
  agentReadyPattern: agent.agentReadyPattern,
})

/**
 * 启动临时进程执行 agent 的 update 命令，等它完成后返回。
 * 失败时 warn 但不抛错，由调用方决定是否继续。
 * 未配置 updateCommand 时直接返回 true。
 */
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

/**
 * 读取 agent 输出，若未通过 `isValid` 校验则重试。
 * 用于 task completed 后 5 秒首次读取时输出尚未同步的有限重试，
 * 不重新派发任务。
 *
 * @param isValid — 输出内容合法判定：应校验结果分隔符与正文非空
 * @param readFn  — 可注入的读取函数（默认 readAgentOutput），便于测试
 */
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
