import { existsSync } from "node:fs"
import { unlink, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"

import type { AgentConfig } from "../types.js"
import { createPaneBridge, type PaneBridge } from "./pane-bridge.js"
import type { SessionClient } from "./client.js"
import type { SessionInputEvent } from "./types.js"
import type { SessionStreamEvent } from "./types.js"

export type RunnerHandle = {
  sessionId: string
  stop: () => Promise<void>
}

export type RunnerSupervisor = {
  start: () => Promise<RunnerHandle>
  stop: () => Promise<void>
}

type SupervisorOptions = {
  agent: AgentConfig
  baseUrl: string
  paneBridge?: PaneBridge
  projectDir: string
  readyTimeoutMs?: number
  runDirectory: string
  runnerEntry?: string
  runnerToken: string
  sessionClient: Pick<SessionClient, "get" | "postEvent" | "stream">
  sessionId: string
}

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

const event = (input: SessionInputEvent) => input

// 从 mini-orchestrator 自身 node_modules 解析 tsx CLI 入口，避免依赖目标项目的依赖树
const resolveTsxCli = () => {
  try {
    const require = createRequire(import.meta.url)
    return require.resolve("tsx/cli")
  } catch {
    return undefined
  }
}

// 按源码/发布环境解析 runner 入口；源码模式下返回 tsx CLI 路径用于 TypeScript 执行
const resolveRunnerEntry = (): { entry: string; tsxPath?: string } => {
  const jsEntry = fileURLToPath(new URL("./internal-runner.js", import.meta.url))
  if (existsSync(jsEntry)) return { entry: jsEntry }
  const tsEntry = fileURLToPath(new URL("./internal-runner.ts", import.meta.url))
  if (existsSync(tsEntry)) return { entry: tsEntry, tsxPath: resolveTsxCli() }
  // 编译产物不存在时回退到 .js 路径，让 node 报出明确的错误
  return { entry: jsEntry }
}

const waitForReady = async (
  client: Pick<SessionClient, "stream">,
  sessionId: string,
  timeoutMs: number,
  signal?: AbortSignal,
  onSubscribed?: () => void,
) => {
  let iterator: AsyncIterator<Awaited<ReturnType<typeof client.stream>> extends AsyncIterable<infer T> ? T : never> | undefined
  const wait = async () => {
    iterator = client.stream(sessionId)[Symbol.asyncIterator]()
    while (true) {
      const next = await iterator.next()
      if (next.done) throw new Error("[Session] Runner stream closed before ready")
      onSubscribed?.()
      if (next.value.type === "runner.ready") return
    }
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  try {
    const cancelled = signal
      ? new Promise<never>((_, reject) => {
          abort = () => reject(new Error("[Session] Runner ready wait cancelled"))
          signal.addEventListener("abort", abort, { once: true })
        })
      : undefined
    await Promise.race([
      wait(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`[Session] Runner did not become ready within ${timeoutMs}ms`)), timeoutMs)
      }),
      ...(cancelled ? [cancelled] : []),
    ])
  } finally {
    if (timer) clearTimeout(timer)
    if (abort && signal) signal.removeEventListener("abort", abort)
    void iterator?.return?.()
  }
}

const waitForRunnerExit = async (
  client: Pick<SessionClient, "stream">,
  sessionId: string,
  timeoutMs: number,
) => {
  const iterator = client.stream(sessionId)[Symbol.asyncIterator]()
  const wait = async () => {
    while (true) {
      const next = await iterator.next()
      if (next.done) return false
      const event = next.value as SessionStreamEvent
      if (event.type === "runner.status" && (event.data?.status === "stopped" || event.data?.status === "failed")) return true
    }
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([wait(), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs) })])
  } finally {
    if (timer) clearTimeout(timer)
    void iterator.return?.()
  }
}

export const createRunnerSupervisor = (options: SupervisorOptions): RunnerSupervisor => {
  const paneBridge = options.paneBridge ?? createPaneBridge()
  const configPath = path.join(options.runDirectory, `.session-runner-${options.sessionId}.json`)
  let paneId: string | undefined
  let started: RunnerHandle | undefined
  let stopping: Promise<void> | undefined
  let stopWatching: (() => void) | undefined
  let readyController: AbortController | undefined
  let ready: Promise<void> | undefined
  let failure: Promise<void> | undefined

  const cleanupConfig = async () => {
    await unlink(configPath).catch(() => undefined)
  }

  const reportFailure = (error: Error) => {
    if (failure) return failure
    failure = (async () => {
      readyController?.abort()
      stopWatching?.()
      await options.sessionClient.postEvent(options.sessionId, event({
        data: { reason: error.message },
        eventId: `runner-failure-${options.sessionId}`,
        type: "runner.failure",
      })).catch(() => undefined)
      if (paneId) await paneBridge.close(paneId).catch(() => undefined)
      await cleanupConfig()
      paneId = undefined
      started = undefined
    })()
    return failure
  }

  const start = async () => {
    if (started) return started
    try {
      paneId = await paneBridge.split(options.projectDir)
      await writeFile(configPath, JSON.stringify({
        agent: options.agent,
        baseUrl: options.baseUrl,
        projectDir: options.projectDir,
        runnerToken: options.runnerToken,
        runDirectory: options.runDirectory,
        sessionId: options.sessionId,
        statePath: path.join(options.runDirectory, `.session-runner-${options.sessionId}.state.json`),
        workspace: options.projectDir,
      }), { encoding: "utf8", mode: 0o600 })
      const resolved = options.runnerEntry
        ? { entry: options.runnerEntry }
        : resolveRunnerEntry()
      // Subscribe before bootstrap: a fast runner may publish ready before the pane command returns.
      readyController = new AbortController()
      let subscribedResolve: (() => void) | undefined
      const subscribed = new Promise<void>(resolve => { subscribedResolve = resolve })
      ready = waitForReady(
        options.sessionClient,
        options.sessionId,
        options.readyTimeoutMs ?? 120_000,
        readyController.signal,
        () => subscribedResolve?.(),
      )
      stopWatching = paneBridge.watch?.(paneId, error => { void reportFailure(error) })
      await Promise.race([subscribed, ready])
      // 源码模式用 mini-orchestrator 自身的 tsx 执行 TypeScript，避免依赖目标项目的依赖树
      const runnerCommand = resolved.tsxPath
        ? `${quote(process.execPath)} ${quote(resolved.tsxPath)} ${quote(resolved.entry)} --config ${quote(configPath)}`
        : `${quote(process.execPath)} ${quote(resolved.entry)} --config ${quote(configPath)}`
      await paneBridge.bootstrap(paneId, runnerCommand)
      await ready
      started = { sessionId: options.sessionId, stop }
      return started
    } catch (error) {
      // Stop the pending SSE/timer wait when bootstrap itself fails.
      await reportFailure(error instanceof Error ? error : new Error(String(error)))
      await ready?.catch(() => undefined)
      throw error
    }
  }

  const stop = async () => {
    if (stopping) return stopping
    stopping = (async () => {
      const currentPane = paneId
      if (!currentPane) return
      try {
        const session = await options.sessionClient.get(options.sessionId).catch(() => undefined)
        // Preserve a terminal failure reported by the runner; cleanup must not rewrite it as stopped.
        if (session?.status === "failed" || session?.status === "stopped") return
        if (session?.activeTurnId) {
          await options.sessionClient.postEvent(options.sessionId, event({
            data: { turnId: session.activeTurnId },
            eventId: `interrupt-${options.sessionId}`,
            type: "interrupt",
          }))
        }
        const runnerExit = waitForRunnerExit(options.sessionClient, options.sessionId, 2_000)
        await options.sessionClient.postEvent(options.sessionId, event({
          eventId: `stop-${options.sessionId}`,
          type: "stop",
        }))
        const exited = await runnerExit
        if (!exited) {
          await options.sessionClient.postEvent(options.sessionId, event({
            data: { reason: "Runner did not exit during stop" },
            eventId: `runner-stop-timeout-${options.sessionId}`,
            type: "runner.failure",
          })).catch(() => undefined)
        }
      } finally {
        stopWatching?.()
        stopWatching = undefined
        await paneBridge.close(currentPane).catch(() => undefined)
        await cleanupConfig()
        paneId = undefined
        started = undefined
      }
    })()
    return stopping
  }

  return { start, stop }
}
