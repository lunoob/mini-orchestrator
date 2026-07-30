import { readFile, unlink } from "node:fs/promises"

import type { AgentConfig } from "../types.js"
import { notifyNeedsInput } from "../notify/index.js"
import { formatActivity } from "./activity.js"
import { createSessionClient } from "./client.js"
import { createSessionAdapter } from "./adapters/factory.js"
import type { AdapterEvent, AdapterNotification } from "./adapters/types.js"
import { createRunnerClient, type InteractionRequest, type InteractionResult } from "./runner-client.js"
import {
  mapRequestToPrompt,
  executePrompt,
  createClackPromptPort,
  type PromptPort,
} from "./interaction-prompt.js"
import type { SessionInputEvent } from "./types.js"

export type InternalRunnerConfig = {
  agent: AgentConfig
  baseUrl: string
  projectDir: string
  runnerToken: string
  runDirectory: string
  sessionId: string
  statePath?: string
  workspace: string
}

const renderState = { atLineStart: true }

export const resetRunnerRenderState = () => {
  renderState.atLineStart = true
}

const writeStatusLine = (line: string) => {
  const prefix = renderState.atLineStart ? "" : "\n"
  process.stdout.write(`${prefix}${line}\n`)
  renderState.atLineStart = true
}

export const renderRunnerEvent = (event: AdapterEvent) => {
  if (event.type === "output_text.delta") {
    process.stdout.write(event.data.delta)
    if (event.data.delta.length > 0) renderState.atLineStart = event.data.delta.endsWith("\n")
    return
  }
  if (event.type === "activity") {
    writeStatusLine(formatActivity(event.data.activity))
    return
  }
  if (event.type === "turn.completed") {
    writeStatusLine("[Turn ✓] completed")
    return
  }
  if (event.type === "turn.failed") {
    const reason = event.data.reason ? ` — ${event.data.reason}` : ""
    writeStatusLine(`[Turn ✗] failed${reason}`)
    return
  }
  if (event.type === "turn.interrupted") {
    writeStatusLine("[Turn ✗] interrupted")
    return
  }
  // Fallback for other events
  const turnId = event.data.turnId
  writeStatusLine(`[Session] ${event.type} ${turnId}`)
}

export const renderAdapterNotification = (notification: AdapterNotification) => {
  if (notification.method === "item/agentMessage/delta") return
  process.stdout.write(`\n[Session] ${notification.method}\n`)
}

const readConfigPath = () => {
  const index = process.argv.indexOf("--config")
  const configPath = index >= 0 ? process.argv[index + 1] : undefined
  if (!configPath) throw new Error("[Session] Internal runner requires --config")
  return configPath
}

const readConfig = async (configPath: string) => {
  const parsed = JSON.parse(await readFile(configPath, "utf8")) as Partial<InternalRunnerConfig>
  if (!parsed.baseUrl || !parsed.runnerToken || !parsed.sessionId || !parsed.agent || !parsed.workspace) {
    throw new Error("[Session] Internal runner configuration is incomplete")
  }
  return parsed as InternalRunnerConfig
}

export const runInternalRunner = async (config: InternalRunnerConfig) => {
  const client = createSessionClient({ baseUrl: config.baseUrl, token: config.runnerToken })
  let runner: ReturnType<typeof createRunnerClient> | undefined
  // Unified post function: uses runner-client's controllerId-wrapped path when available,
  // falls back to direct postEvent before runner is initialized (e.g. early failures).
  const post = (event: SessionInputEvent) =>
    runner ? runner.postRunnerEvent(event) : client.postEvent(config.sessionId, event)
  const adapter = createSessionAdapter({
    agent: config.agent,
    cwd: config.workspace,
    onEvent: async event => {
      renderRunnerEvent(event)
      await post({ ...event, source: "runner" } as SessionInputEvent)
    },
    onFailure: async error => {
      // 上报 runner.failure 携带具体错误原因，供 Session 状态机持久化
      await post({ data: { reason: error.message }, type: "runner.failure" })
      // Report terminal status via runner-client to release lease
      await runner?.reportTerminalStatus("failed", error.message)
      runner?.stop()
      await adapter.stop()
      process.exitCode = 1
      console.error(`[Session] Agent process failed: ${error.message}`)
    },
    onNotification: renderAdapterNotification,
  })

  // Interaction handler: use Clack prompts for user input
  let promptPort: PromptPort | undefined
  const onInteraction = async (request: InteractionRequest): Promise<InteractionResult> => {
    // Send notification before showing prompt (notification failure must not block prompt)
    try { notifyNeedsInput(request.request.question) } catch { /* ignore */ }
    if (!promptPort) promptPort = await createClackPromptPort()
    const prompt = mapRequestToPrompt(request.request)
    process.stdout.write(`\n[Session] 需要用户输入: ${request.request.question}\n`)
    return executePrompt(promptPort, prompt)
  }

  runner = createRunnerClient({
    client,
    onInterrupt: turnId => adapter.interrupt(turnId),
    onInteraction,
    onMessage: message => adapter.deliverMessage(message),
    onReady: () => process.stdout.write("[Session] runner ready\n"),
    onStop: () => adapter.stop(),
    sessionId: config.sessionId,
    statePath: config.statePath,
  })

  const onSignal = () => {
    void (async () => {
      const session = await client.get(config.sessionId).catch(() => undefined)
      if (session) {
        for (const turn of session.turns.filter(candidate => !["completed", "failed", "interrupted"].includes(candidate.status))) {
          await post({ data: { reason: "runner process terminated", turnId: turn.id }, source: "runner", type: "turn.failed" }).catch(() => undefined)
        }
      }
      // Report terminal status via runner-client to release lease
      await runner?.reportTerminalStatus("failed", "runner process terminated")
      runner?.stop()
      await adapter.stop()
      process.exitCode = 1
    })()
  }
  process.once("SIGTERM", onSignal)
  process.once("SIGHUP", onSignal)
  try {
    await adapter.start()
    await runner.run()
  } finally {
    process.off("SIGTERM", onSignal)
    process.off("SIGHUP", onSignal)
  }
}

const main = async () => {
  const configPath = readConfigPath()
  const config = await readConfig(configPath)
  try {
    await runInternalRunner(config)
  } catch (error) {
    const client = createSessionClient({ baseUrl: config.baseUrl, token: config.runnerToken })
    const reason = error instanceof Error ? error.message : String(error)
    try {
      const session = await client.get(config.sessionId)
      for (const turn of session.turns.filter(candidate => !["completed", "failed", "interrupted"].includes(candidate.status))) {
        await client.postEvent(config.sessionId, { data: { reason, turnId: turn.id }, source: "runner", type: "turn.failed" })
      }
      await client.postEvent(config.sessionId, { data: { status: "failed" }, source: "runner", type: "runner.status" })
    } catch {
      // The parent may already have stopped the session; there is no second channel to report on.
    }
    throw error
  } finally {
    await unlink(configPath).catch(() => undefined)
  }
}

if (process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url) {
  void main().catch(error => {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[Session] Internal runner failed: ${message}`)
    process.exitCode = 1
  })
}
