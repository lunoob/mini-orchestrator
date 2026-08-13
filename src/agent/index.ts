import { spawn } from "node:child_process"

import type { AgentConfig, AgentListResult, AgentStartResult, PaneSplitResult } from "../types.js"
import {
  buildBootstrapCommand,
  buildClaudeBootstrapStep1Command,
  buildClaudeBootstrapStep2Command,
  buildResumeArgs,
  parseBootstrapOutput,
} from "../config/agents.js"
import type { AgentSessionHandle, AgentStatus, TranscriptEvent } from "./transcript/types.js"
import { createTranscriptMonitor } from "./transcript/monitor.js"
import { splitCommand } from "../lib/utils.js"
import {
  formatIntegrationFailure,
  formatIntegrationStart,
  formatUpdateFailure,
  formatUpdateStart,
} from "./log-messages.js"
import { runHerdr, tryRunHerdr } from "./subprocess.js"
import { waitForAgentReady } from "./readiness.js"
import type { OutputCallback } from "./subprocess.js"
export type { OutputCallback }

const DEFAULT_MONITOR_POLL_MS = 10_000
const DEFAULT_MONITOR_TIMEOUT_MS = 3_600_000

// ── Agent listing / naming ──

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

export type StartAgentOptions = { ensureUniqueName?: boolean }

// ── Agent pane / start ──

const createAgentPane = async (projectDir: string) => {
  const output = await runHerdr([
    "pane", "split", "--current", "--direction", "right",
    "--cwd", projectDir, "--no-focus",
  ])
  const parsed = JSON.parse(output) as PaneSplitResult
  return parsed.result.pane.pane_id
}

const startAgentWithName = async (projectDir: string, agent: AgentConfig, name: string) => {
  const paneId = await createAgentPane(projectDir)
  const agentArgs = splitCommand(agent.command).slice(1)
  const startArgs = [
    "agent", "start", name, "--kind", agent.integrationAgent,
    "--pane", paneId,
    ...(agentArgs.length > 0 ? ["--", ...agentArgs] : []),
  ]
  const output = await runHerdr(startArgs)
  const parsed = JSON.parse(output) as AgentStartResult
  return parsed.result.agent.pane_id
}

export const startAgent = async (
  projectDir: string, agent: AgentConfig, options: StartAgentOptions = {},
) => {
  let name = agent.name
  if (options.ensureUniqueName) {
    name = await resolveUniqueAgentName(agent.name)
    if (name !== agent.name) console.log(`[Agent] Name "${agent.name}" is taken; using "${name}" instead.`)
  }
  return startAgentWithName(projectDir, agent, name)
}

// ── Agent communication ──

export const sendTask = async (paneId: string, prompt: string) => {
  await runHerdr(["pane", "send-text", paneId, prompt])
  await runHerdr(["pane", "send-keys", paneId, "enter"])
}

export const isPaneNotFoundError = (stderr: string) =>
  /"code"\s*:\s*"pane_not_found"|pane .+ not found/i.test(stderr)

export const stopAgent = async (paneId: string) => {
  const { code, stderr } = await tryRunHerdr(["pane", "close", paneId])
  if (code === 0) return
  if (/"code"\s*:\s*"pane_not_found"|pane .+ not found/i.test(stderr)) {
    console.warn(`[Agent] Pane already closed, skipping stop: ${paneId}`)
    return
  }
  throw new Error(`[Agent] ${stderr || `herdr pane close ${paneId} failed with code ${code}`}`)
}

export const readAgentOutput = async (paneId: string, lines: number) =>
  runHerdr(["agent", "read", paneId, "--source", "recent-unwrapped", "--lines", String(lines)])

export const readAgentOutputWithRetry = async (
  paneId: string, lines: number, isValid: (output: string) => boolean,
  maxRetries = 3, retryIntervalMs = 1500,
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
  throw new Error(`[Agent] Task completed but output not synced after ${maxRetries} retries for pane ${paneId}.`)
}

// ── Agent lifecycle ──

/**
 * 启动子进程并捕获输出，通过 onOutput 回调转发。
 * 避免使用 stdio: "inherit" 导致子进程输出绕过 Blessed UI 覆盖终端内容。
 */
const spawnWithOutput = (
  cmd: string, args: string[], opts: { cwd: string },
  onOutput?: OutputCallback,
): Promise<{ code: number | null }> =>
  new Promise<{ code: number | null }>((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    if (onOutput) {
      child.stdout?.on("data", (chunk: Buffer | string) => {
        for (const line of chunk.toString().split("\n")) {
          if (line) onOutput(line, "stdout")
        }
      })
      child.stderr?.on("data", (chunk: Buffer | string) => {
        for (const line of chunk.toString().split("\n")) {
          if (line) onOutput(line, "stderr")
        }
      })
    }
    child.on("error", reject)
    child.on("close", (code) => resolve({ code }))
  })

export const runAgentUpdate = async (
  projectDir: string, agent: AgentConfig,
): Promise<boolean> => {
  if (!agent.updateCommand) return true
  console.log(formatUpdateStart(agent.updateCommand))
  const [cmd, ...args] = splitCommand(agent.updateCommand)
  // 更新 CLI 可能输出基于 \r 的实时进度条，不转发其过程输出，避免污染终端日志。
  const { code } = await spawnWithOutput(cmd, args, { cwd: projectDir })
  if (code !== 0) {
    console.warn(formatUpdateFailure(code))
    return false
  }
  return true
}

export const runAgentIntegration = async (agent: AgentConfig, onOutput?: OutputCallback): Promise<boolean> => {
  console.log(formatIntegrationStart(agent.integrationAgent))
  const { code } = await tryRunHerdr(["integration", "install", agent.integrationAgent], onOutput)
  if (code !== 0) {
    console.warn(formatIntegrationFailure(code))
    return false
  }
  return true
}

// ── JSONL-based session management ──

/**
 * 构建 bootstrap meta prompt，注入当前工作的项目目录路径，
 * 避免 agent 受 memory 影响找错目录、输出错误的 resume_id。
 */
const buildBootstrapMetaPrompt = (projectDir: string) => [
  `当前 cwd 路径为: ${projectDir}`,
  `我给你读取的权限，输出本次会话的 sessionId/resumeId，消息持久化 jsonl 文件的位置。输出 json 字符串即可，格式如: { resumeId, jsonl }, 不要使用 markdown 代码块。`,
  `只依据我给的当前工作目录推导，与 memory 无关。`
].join("\n")

/**
 * 执行 headless 命令并返回 stdout。cwd 固定为项目目录，
 * 确保 headless 进程实际运行目录与 prompt 中注入的目录一致。
 */
const execHeadless = async (shellCommand: string, cwd: string): Promise<{ stdout: string; code: number | null }> => {
  return new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
    const child = spawn(shellCommand, {
      env: process.env, shell: true, cwd, stdio: ["ignore", "pipe", "pipe"],
    })
    let out = ""
    child.stdout.on("data", (chunk: Buffer | string) => { out += chunk.toString() })
    child.on("error", reject)
    child.on("close", (exitCode) => resolve({ code: exitCode, stdout: out }))
  })
}

/**
 * 等待 JSONL 文件就绪（最多 15 秒）。
 */
const waitForJsonlReady = async (jsonlPath: string, agentName: string): Promise<number> => {
  const { open } = await import("node:fs/promises")
  const deadline = Date.now() + 15_000

  while (Date.now() < deadline) {
    try {
      const fh = await open(jsonlPath, "r")
      const stat = await fh.stat()
      if (stat.size > 0) {
        const buffer = Buffer.alloc(stat.size)
        const { bytesRead } = await fh.read(buffer, 0, stat.size, 0)
        if (buffer.toString("utf8", 0, bytesRead).includes("\n")) {
          await fh.close()
          return stat.size
        }
      }
      await fh.close()
    } catch { /* JSONL not ready */ }
    await new Promise((r) => setTimeout(r, 500))
  }

  throw new Error(`[Agent] Bootstrap failed for "${agentName}": JSONL not ready within 15s: ${jsonlPath}`)
}

/**
 * Claude bootstrap 的两步流程：
 * Step 1: 发送 "Hello" 获取 session_id
 * Step 2: 使用 session_id 恢复会话并获取 resumeId 和 jsonl
 */
const bootstrapClaudeSession = async (
  projectDir: string, agent: AgentConfig, metaPrompt: string,
): Promise<AgentSessionHandle> => {
  // Step 1: 发送 "Hello" 获取 session_id
  const step1Command = buildClaudeBootstrapStep1Command(agent)
  console.log(`[Agent] Bootstrap Step 1: Getting session_id for "${agent.name}"...`)

  const { stdout: step1Output, code: step1Code } = await execHeadless(step1Command, projectDir)
  if (step1Code !== 0) {
    throw new Error(`[Agent] Bootstrap Step 1 failed for "${agent.name}" (exit ${step1Code})`)
  }

  // 解析 Step 1 输出，提取 session_id
  let step1Parsed: unknown
  try {
    step1Parsed = JSON.parse(step1Output.trim())
  } catch {
    throw new Error(
      `[Agent] Bootstrap Step 1 failed for "${agent.name}": invalid JSON output. ` +
      `stdout was: ${step1Output.slice(0, 500)}`,
    )
  }

  const sessionId = (step1Parsed as Record<string, unknown>)?.session_id
  if (typeof sessionId !== "string" || !sessionId.trim()) {
    throw new Error(
      `[Agent] Bootstrap Step 1 failed for "${agent.name}": session_id not found in output. ` +
      `stdout was: ${step1Output.slice(0, 500)}`,
    )
  }

  console.log(`[Agent] Bootstrap Step 1 OK: session_id=${sessionId}`)

  // Step 2: 使用 session_id 恢复会话并获取 resumeId 和 jsonl
  const step2Command = buildClaudeBootstrapStep2Command(agent, sessionId, metaPrompt)
  console.log(`[Agent] Bootstrap Step 2: Getting resumeId and jsonl for "${agent.name}"...`)

  const { stdout: step2Output, code: step2Code } = await execHeadless(step2Command, projectDir)
  if (step2Code !== 0) {
    throw new Error(`[Agent] Bootstrap Step 2 failed for "${agent.name}" (exit ${step2Code})`)
  }

  // 解析 Step 2 输出
  const handle = parseBootstrapOutput(step2Output, agent.agent as AgentSessionHandle["provider"])
  if (!handle) {
    throw new Error(
      `[Agent] Bootstrap Step 2 failed for "${agent.name}": could not parse { resumeId, jsonl } from stdout. ` +
      `stdout was: ${step2Output.slice(0, 500)}`,
    )
  }

  // 等待 JSONL 就绪
  handle.offset = await waitForJsonlReady(handle.jsonl, agent.name)

  console.log(`[Agent] Bootstrap OK: resumeId=${handle.resumeId}, jsonl=${handle.jsonl}, offset=${handle.offset}`)
  return handle
}

export const bootstrapSession = async (
  projectDir: string, agent: AgentConfig, metaPrompt?: string,
): Promise<AgentSessionHandle> => {
  const prompt = metaPrompt ?? buildBootstrapMetaPrompt(projectDir)

  let handle: AgentSessionHandle
  if (agent.agent === "claude") {
    // Claude 使用两步 bootstrap 流程
    handle = await bootstrapClaudeSession(projectDir, agent, prompt)
  } else {
    // 其他 agent 使用单步 bootstrap 流程
    const shellCommand = buildBootstrapCommand(agent, prompt)
    console.log(`[Agent] Bootstrapping session for "${agent.name}" (${agent.agent})...`)

    const { stdout, code } = await execHeadless(shellCommand, projectDir)
    if (code !== 0) throw new Error(`[Agent] Bootstrap failed for "${agent.name}" (exit ${code})`)

    const parsed = parseBootstrapOutput(stdout, agent.agent as AgentSessionHandle["provider"])
    if (!parsed) {
      throw new Error(
        `[Agent] Bootstrap failed for "${agent.name}": could not parse { resumeId, jsonl } from stdout. ` +
        `stdout was: ${stdout.slice(0, 500)}`,
      )
    }
    handle = parsed

    // 等待 JSONL 就绪
    handle.offset = await waitForJsonlReady(handle.jsonl, agent.name)

    console.log(`[Agent] Bootstrap OK: resumeId=${handle.resumeId}, jsonl=${handle.jsonl}, offset=${handle.offset}`)
  }

  // 延迟 5s 返回，确保 JSONL 稳定落盘后再启动 agent
  await new Promise((resolve) => setTimeout(resolve, 5_000))
  return handle
}

const startAgentWithResumeId = async (
  projectDir: string, agent: AgentConfig, name: string,
  session: Pick<AgentSessionHandle, "resumeId" | "jsonl">,
) => {
  const paneId = await createAgentPane(projectDir)
  const resumeCommand = buildResumeArgs(agent, session.resumeId)
  const agentArgs = splitCommand(resumeCommand).slice(1)
  const startArgs = [
    "agent", "start", name, "--kind", agent.integrationAgent,
    "--pane", paneId,
    ...(agentArgs.length > 0 ? ["--", ...agentArgs] : []),
  ]
  const output = await runHerdr(startArgs)
  const parsed = JSON.parse(output) as AgentStartResult
  return parsed.result.agent.pane_id
}

export const startAgentResumed = async (
  projectDir: string, agent: AgentConfig,
  session: Pick<AgentSessionHandle, "resumeId" | "jsonl">,
  options: StartAgentOptions = {},
) => {
  let name = agent.name
  if (options.ensureUniqueName) {
    name = await resolveUniqueAgentName(agent.name)
    if (name !== agent.name) console.log(`[Agent] Name "${agent.name}" is taken; using "${name}" instead.`)
  }
  const paneId = await startAgentWithResumeId(projectDir, agent, name, session)
  try {
    await waitForAgentReady(paneId, session, { read: readAgentOutput })
    return paneId
  } catch (error) {
    await stopAgent(paneId)
    throw error
  }
}

// ── Transcript monitor ──

export const waitForAgentWithMonitor = async (
  sessionHandle: AgentSessionHandle,
  options: {
    pollIntervalMs?: number; timeoutMs?: number; signal?: AbortSignal
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
        return { finalText: monitor.getAccumulatedText(), finalOffset: monitor.getOffset(), lastEvent, status }
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
    }
    throw new Error(`[Agent] Monitor timed out after ${timeoutMs}ms for ${sessionHandle.provider}/${sessionHandle.resumeId}`)
  } finally {
    await monitor.close()
  }
}

export const sendTaskAndMonitor = async (
  paneId: string, prompt: string, sessionHandle: AgentSessionHandle,
  options: { pollIntervalMs?: number; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<{ finalText: string; status: AgentStatus; question?: string; reason?: string }> => {
  await sendTask(paneId, prompt)
  await new Promise((resolve) => setTimeout(resolve, 2000))
  const result = await waitForAgentWithMonitor(sessionHandle, options)
  sessionHandle.offset = result.finalOffset
  return { finalText: result.finalText, question: result.lastEvent?.question, reason: result.lastEvent?.reason, status: result.status }
}
