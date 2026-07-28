import { readFile, unlink } from "node:fs/promises"

import type { AgentConfig } from "../types.js"
import { createSessionClient } from "./client.js"
import { createSessionAdapter } from "./adapters/factory.js"
import type { AdapterEvent, AdapterNotification } from "./adapters/types.js"
import { createRunnerClient } from "./runner-client.js"
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

export const renderRunnerEvent = (event: AdapterEvent) => {
  const turnId = event.data.turnId
  if (event.type === "output_text.delta") {
    process.stdout.write(event.data.delta)
    return
  }
  const status = event.type.replace("turn.", "")
  process.stdout.write(`\n[Session] turn ${turnId} ${status}\n`)
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
  const post = (event: SessionInputEvent) => client.postEvent(config.sessionId, event)
  let runner: ReturnType<typeof createRunnerClient> | undefined
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
      runner?.stop()
      // 停止 adapter 以终止底层 CLI 子进程，防止进程残留
      await adapter.stop()
      process.exitCode = 1
      console.error(`[Session] Agent process failed: ${error.message}`)
    },
    onNotification: renderAdapterNotification,
  })
  runner = createRunnerClient({
    client,
    onInterrupt: turnId => adapter.interrupt(turnId),
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
        await post({ data: { status: "failed" }, source: "runner", type: "runner.status" }).catch(() => undefined)
      }
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
