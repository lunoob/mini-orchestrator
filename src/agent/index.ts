import { spawn } from "node:child_process"

import type { AgentConfig, AgentListResult, AgentStartResult, PaneSplitResult } from "../types.js"
import { buildBootstrapCommand, buildResumeArgs, parseBootstrapOutput } from "../config/agents.js"
import type { AgentSessionHandle, AgentStatus, TranscriptEvent } from "./transcript/types.js"
import { createTranscriptMonitor } from "./transcript/monitor.js"
import { splitCommand } from "../lib/utils.js"
import { runHerdr, tryRunHerdr } from "./subprocess.js"

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

export const runAgentUpdate = async (projectDir: string, agent: AgentConfig): Promise<boolean> => {
  if (!agent.updateCommand) return true
  console.log(`[Agent] Running update for "${agent.name}": ${agent.updateCommand}`)
  const [cmd, ...args] = splitCommand(agent.updateCommand)
  const { code } = await new Promise<{ code: number | null }>((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: projectDir, env: process.env, stdio: "inherit" })
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
  console.log(`[Agent] Running herdr integration for "${agent.name}": herdr integration ${agent.integrationAgent}`)
  const { code } = await tryRunHerdr(["integration", "install", agent.integrationAgent])
  if (code !== 0) {
    console.warn(`[Agent] Integration for "${agent.name}" failed (exit code ${code}), continuing anyway.`)
    return false
  }
  return true
}

// ── JSONL-based session management ──

const BOOTSTRAP_META_PROMPT = [
  "Output ONLY the following JSON object with your session metadata. Do not output anything else.",
  '{"resumeId":"<your-session-resume-id>","jsonl":"<absolute-path-to-your-session-jsonl-file>"}',
  "IMPORTANT: Output ONLY the JSON object, no markdown fences, no other text.",
].join("\n")

export const bootstrapSession = async (
  agent: AgentConfig, metaPrompt?: string,
): Promise<AgentSessionHandle> => {
  const prompt = metaPrompt ?? BOOTSTRAP_META_PROMPT
  const shellCommand = buildBootstrapCommand(agent, prompt)
  console.log(`[Agent] Bootstrapping session for "${agent.name}" (${agent.agent})...`)

  const { stdout, code } = await new Promise<{ code: number | null; stdout: string }>(
    (resolve, reject) => {
      const child = spawn(shellCommand, {
        env: process.env, shell: true, stdio: ["ignore", "pipe", "pipe"],
      })
      let out = ""
      child.stdout.on("data", (chunk: Buffer | string) => { out += chunk.toString() })
      child.on("error", reject)
      child.on("close", (exitCode) => resolve({ code: exitCode, stdout: out }))
    },
  )

  if (code !== 0) throw new Error(`[Agent] Bootstrap failed for "${agent.name}" (exit ${code})`)

  const handle = parseBootstrapOutput(stdout, agent.agent as AgentSessionHandle["provider"])
  if (!handle) {
    throw new Error(
      `[Agent] Bootstrap failed for "${agent.name}": could not parse { resumeId, jsonl } from stdout. ` +
      `stdout was: ${stdout.slice(0, 500)}`,
    )
  }

  // Wait for JSONL to be ready
  const { open } = await import("node:fs/promises")
  const jsonlWaitDeadline = Date.now() + 15_000
  let jsonlReady = false

  while (Date.now() < jsonlWaitDeadline) {
    try {
      const fh = await open(handle.jsonl, "r")
      const stat = await fh.stat()
      if (stat.size > 0) {
        const buffer = Buffer.alloc(stat.size)
        const { bytesRead } = await fh.read(buffer, 0, stat.size, 0)
        if (buffer.toString("utf8", 0, bytesRead).includes("\n")) {
          handle.offset = stat.size
          await fh.close()
          jsonlReady = true
          break
        }
      }
      await fh.close()
    } catch { /* JSONL not ready */ }
    await new Promise((r) => setTimeout(r, 500))
  }

  if (!jsonlReady) {
    throw new Error(`[Agent] Bootstrap failed for "${agent.name}": JSONL not ready within 15s: ${handle.jsonl}`)
  }

  console.log(`[Agent] Bootstrap OK: resumeId=${handle.resumeId}, jsonl=${handle.jsonl}, offset=${handle.offset}`)
  return handle
}

const startAgentWithResumeId = async (
  projectDir: string, agent: AgentConfig, name: string, resumeId: string,
) => {
  const paneId = await createAgentPane(projectDir)
  const resumeCommand = buildResumeArgs(agent, resumeId)
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
  projectDir: string, agent: AgentConfig, resumeId: string,
  options: StartAgentOptions = {},
) => {
  let name = agent.name
  if (options.ensureUniqueName) {
    name = await resolveUniqueAgentName(agent.name)
    if (name !== agent.name) console.log(`[Agent] Name "${agent.name}" is taken; using "${name}" instead.`)
  }
  return startAgentWithResumeId(projectDir, agent, name, resumeId)
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
