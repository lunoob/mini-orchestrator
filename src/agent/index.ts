import { spawn } from "node:child_process"

import type { AgentConfig, AgentListResult, AgentStartResult, PaneSplitResult } from "../types.js"
import { buildBootstrapCommand, buildResumeArgs, parseBootstrapOutput } from "../config/agents.js"
import type { AgentSessionHandle, AgentStatus, TranscriptEvent } from "./transcript/types.js"
import { createTranscriptMonitor } from "./transcript/monitor.js"
import { splitCommand } from "../lib/utils.js"
import { waitForCompletionWithFallback } from "./completion-wait.js"
import { runHerdr, tryRunHerdr } from "./subprocess.js"
import { AGENT_COMPLETE_STATUSES, isAgentCompleteStatus, readAgentStatus, waitForAgentStatus } from "./status-wait.js"

const DEFAULT_READY_TIMEOUT_MS = 120_000
const DEFAULT_OUTPUT_MATCH_TIMEOUT_MS = 60_000
const DEFAULT_WORKING_TIMEOUT_MS = 60_000
const IDLE_TIMEOUT_MS = 3_600_000
const DEFAULT_MONITOR_POLL_MS = 10_000
const DEFAULT_MONITOR_TIMEOUT_MS = 3_600_000

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

const createAgentPane = async (projectDir: string) => {
  const output = await runHerdr([
    "pane",
    "split",
    "--current",
    "--direction",
    "right",
    "--cwd",
    projectDir,
    "--no-focus",
  ])
  const parsed = JSON.parse(output) as PaneSplitResult
  return parsed.result.pane.pane_id
}

const startAgentWithName = async (projectDir: string, agent: AgentConfig, name: string) => {
  const paneId = await createAgentPane(projectDir)
  const agentArgs = splitCommand(agent.command).slice(1)
  const startArgs = [
    "agent",
    "start",
    name,
    "--kind",
    agent.integrationAgent,
    "--pane",
    paneId,
    ...(agentArgs.length > 0 ? ["--", ...agentArgs] : []),
  ]
  const output = await runHerdr(startArgs)
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
    "pane",
    "wait-output",
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
  await runHerdr(["pane", "send-text", paneId, prompt])
  await runHerdr(["pane", "send-keys", paneId, "enter"])
}

export type WaitForIdleOptions = {
  /** null = 不设总超时（按 chunk 一直等）；默认 IDLE_TIMEOUT_MS */
  timeoutMs?: number | null
}

export const waitForIdle = async (
  paneId: string,
  options: WaitForIdleOptions = {},
): Promise<string | undefined> => {
  const timeoutMs = options.timeoutMs === undefined ? IDLE_TIMEOUT_MS : options.timeoutMs
  const fallbackOutput = await waitForCompletionWithFallback(paneId, {
    log: (message) => console.log(message),
    readOutput: () => readAgentOutput(paneId, 280),
    sleep: (ms) => new Promise(resolve => setTimeout(resolve, ms)),
    // null 原本代表无限等待；兜底触发后统一改为 10 分钟重试，避免永久卡在 Herdr 的错误状态。
    waitForStatus: (waitTimeoutMs) =>
      waitForAgentStatus(
        paneId,
        AGENT_COMPLETE_STATUSES,
        timeoutMs === null ? waitTimeoutMs : Math.min(waitTimeoutMs, timeoutMs),
      ),
  })
  if (fallbackOutput) return fallbackOutput

  await new Promise(resolve => setTimeout(resolve, 2000))

  const status = await readAgentStatus(paneId)
  if (isAgentCompleteStatus(status)) return

  return waitForIdle(paneId, options)
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
  const fallbackOutput = await waitForIdle(paneId)

  return fallbackOutput ?? readAgentOutput(paneId, 280)
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

export const isPaneNotFoundError = (stderr: string) =>
  /"code"\s*:\s*"pane_not_found"|pane .+ not found/i.test(stderr)

export const stopAgent = async (paneId: string) => {
  const { code, stderr } = await tryRunHerdr(["pane", "close", paneId])
  if (code === 0) return
  if (isPaneNotFoundError(stderr)) {
    console.warn(`[Agent] Pane already closed, skipping stop: ${paneId}`)
    return
  }
  throw new Error(`[Agent] ${stderr || `herdr pane close ${paneId} failed with code ${code}`}`)
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

// ── JSONL-based agent session management ──

/** Bootstrap 元数据 prompt：要求 agent 返回会话元数据 JSON */
const BOOTSTRAP_META_PROMPT = [
  "Output ONLY the following JSON object with your session metadata. Do not output anything else.",
  '{"resumeId":"<your-session-resume-id>","jsonl":"<absolute-path-to-your-session-jsonl-file>"}',
  "IMPORTANT: Output ONLY the JSON object, no markdown fences, no other text.",
].join("\n")

/**
 * 通过 headless 命令创建可恢复 agent 会话。
 * 执行 bootstrap shell 命令，解析 stdout 中的 { resumeId, jsonl }。
 * stderr 在进程级忽略（等价于 2>/dev/null），不会传给 CLI。
 */
export const bootstrapSession = async (
  agent: AgentConfig,
  metaPrompt?: string,
): Promise<AgentSessionHandle> => {
  const prompt = metaPrompt ?? BOOTSTRAP_META_PROMPT
  const argv = buildBootstrapCommand(agent, prompt)
  const [cmd, ...args] = argv

  console.log(`[Agent] Bootstrapping session for "${agent.name}" (${agent.agent})...`)

  const { stdout, code } = await new Promise<{
    code: number | null
    stdout: string
  }>((resolve, reject) => {
    // stderr 由进程级忽略，等效于 shell 2>/dev/null
    const child = spawn(cmd, args, {
      env: process.env,
      stdio: ["ignore", "pipe", "ignore"],
    })

    let out = ""

    child.stdout.on("data", (chunk: Buffer | string) => {
      out += chunk.toString()
    })

    child.on("error", reject)
    child.on("close", (exitCode) => resolve({ code: exitCode, stdout: out }))
  })

  if (code !== 0) {
    throw new Error(
      `[Agent] Bootstrap failed for "${agent.name}" (exit ${code})`,
    )
  }

  const handle = parseBootstrapOutput(stdout, agent.agent as AgentSessionHandle["provider"])
  if (!handle) {
    throw new Error(
      `[Agent] Bootstrap failed for "${agent.name}": could not parse { resumeId, jsonl } from stdout. ` +
        `stdout was: ${stdout.slice(0, 500)}`,
    )
  }

  // P2-7: 等待 JSONL 文件出现至少一条完整记录后，初始化 offset 到文件末尾（字节偏移）
  const { open } = await import("node:fs/promises")
  const jsonlWaitDeadline = Date.now() + 15_000
  let jsonlReady = false

  while (Date.now() < jsonlWaitDeadline) {
    try {
      const fh = await open(handle.jsonl, "r")
      const stat = await fh.stat()
      // 文件至少有一条完整 JSONL 行（以 \n 结尾）
      if (stat.size > 0) {
        const buffer = Buffer.alloc(stat.size)
        const { bytesRead } = await fh.read(buffer, 0, stat.size, 0)
        const content = buffer.toString("utf8", 0, bytesRead)
        // 检查是否至少有一条完整行
        if (content.includes("\n")) {
          handle.offset = stat.size // 字节偏移
          await fh.close()
          jsonlReady = true
          break
        }
      }
      await fh.close()
    } catch {
      // JSONL 未创建
    }
    await new Promise((r) => setTimeout(r, 500))
  }

  if (!jsonlReady) {
    throw new Error(
      `[Agent] Bootstrap failed for "${agent.name}": JSONL not ready within 15s: ${handle.jsonl}`,
    )
  }

  console.log(`[Agent] Bootstrap OK: resumeId=${handle.resumeId}, jsonl=${handle.jsonl}, offset=${handle.offset}`)
  return handle
}

/** 使用 resumeId 在 pane 中启动 agent */
const startAgentWithResumeId = async (
  projectDir: string,
  agent: AgentConfig,
  name: string,
  resumeId: string,
) => {
  const paneId = await createAgentPane(projectDir)
  const resumeCommand = buildResumeArgs(agent, resumeId)
  const agentArgs = splitCommand(resumeCommand).slice(1)

  const startArgs = [
    "agent",
    "start",
    name,
    "--kind",
    agent.integrationAgent,
    "--pane",
    paneId,
    ...(agentArgs.length > 0 ? ["--", ...agentArgs] : []),
  ]

  const output = await runHerdr(startArgs)
  const parsed = JSON.parse(output) as AgentStartResult
  return parsed.result.agent.pane_id
}

/**
 * 启动 agent 并恢复已有会话（通过 resumeId）。
 * 与 startAgent 不同，此函数使用 resume args 而非默认 command。
 */
export const startAgentResumed = async (
  projectDir: string,
  agent: AgentConfig,
  resumeId: string,
  options: StartAgentOptions = {},
) => {
  let name = agent.name
  if (options.ensureUniqueName) {
    name = await resolveUniqueAgentName(agent.name)
    if (name !== agent.name) {
      console.log(`[Agent] Name "${agent.name}" is taken; using "${name}" instead.`)
    }
  }

  return startAgentWithResumeId(projectDir, agent, name, resumeId)
}

/**
 * 通过 transcript monitor 等待 agent 完成。
 * 每 pollIntervalMs 读取一次 JSONL，直到达到终态。
 */
export const waitForAgentWithMonitor = async (
  sessionHandle: AgentSessionHandle,
  options: {
    pollIntervalMs?: number
    timeoutMs?: number
    signal?: AbortSignal
  } = {},
): Promise<{ finalText: string; status: AgentStatus; lastEvent?: TranscriptEvent; finalOffset: number }> => {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_MONITOR_POLL_MS
  const timeoutMs = options.timeoutMs ?? DEFAULT_MONITOR_TIMEOUT_MS
  const deadline = Date.now() + timeoutMs

  const monitor = createTranscriptMonitor(sessionHandle)

  try {
    let lastEvent: TranscriptEvent | undefined

    while (Date.now() < deadline) {
      if (options.signal?.aborted) {
        throw new Error(`[Agent] Monitor aborted for ${sessionHandle.provider}/${sessionHandle.resumeId}`)
      }

      const event = await monitor.poll()
      if (event) lastEvent = event

      const status = monitor.getStatus()
      if (status === "completed" || status === "failed" || status === "needs_input") {
        return {
          finalText: monitor.getAccumulatedText(),
          finalOffset: monitor.getOffset(),
          lastEvent,
          status,
        }
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
    }

    throw new Error(
      `[Agent] Monitor timed out after ${timeoutMs}ms for ${sessionHandle.provider}/${sessionHandle.resumeId}`,
    )
  } finally {
    await monitor.close()
  }
}

/**
 * 发送 task 到 agent pane，然后通过 transcript monitor 等待完成。
 * 替代旧的 sendTaskAndWait（基于 Herdr 状态等待/输出读取）。
 */
export const sendTaskAndMonitor = async (
  paneId: string,
  prompt: string,
  sessionHandle: AgentSessionHandle,
  options: {
    pollIntervalMs?: number
    timeoutMs?: number
    signal?: AbortSignal
  } = {},
): Promise<{ finalText: string; status: AgentStatus; question?: string }> => {
  // 发送任务到 pane
  await sendTask(paneId, prompt)

  // 短暂等待让 agent 开始处理
  await new Promise((resolve) => setTimeout(resolve, 2000))

  const result = await waitForAgentWithMonitor(sessionHandle, options)
  // 持久化读取偏移
  sessionHandle.offset = result.finalOffset
  return {
    finalText: result.finalText,
    question: result.lastEvent?.question,
    status: result.status,
  }
}
