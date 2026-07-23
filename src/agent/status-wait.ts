import type { AgentListResult } from "../types.js"
import { runHerdr, tryRunHerdr } from "./subprocess.js"

const POLL_INTERVAL_MS = 2_000
const EVENT_CHUNK_MS = 5_000

/** 设为 true 时启用 agent list 轮询兜底；默认仅用 agent wait 事件等待。 */
export const POLLING_FALLBACK_ENABLED = false

export const AGENT_COMPLETE_STATUSES = ["idle", "done"] as const

export type AgentCompleteStatus = (typeof AGENT_COMPLETE_STATUSES)[number]

export const normalizeTargetStatuses = (target: string | readonly string[]) =>
  (Array.isArray(target) ? target : [target]) as string[]

export const isAgentCompleteStatus = (status: string | undefined): status is AgentCompleteStatus =>
  status !== undefined && (AGENT_COMPLETE_STATUSES as readonly string[]).includes(status)

export const waitAgentStatusArgs = (
  paneId: string,
  status: string | readonly string[],
  timeoutMs: number,
) => {
  const args = ["agent", "wait", paneId, "--timeout", String(timeoutMs)] as string[]
  for (const target of normalizeTargetStatuses(status)) {
    args.push("--until", target)
  }
  return args
}

export const parseAgentStatus = (listOutput: string, paneId: string): string | undefined => {
  const parsed = JSON.parse(listOutput) as AgentListResult
  return parsed.result.agents.find(a => a.pane_id === paneId)?.agent_status
}

export const readAgentStatus = async (paneId: string) => {
  const output = await runHerdr(["agent", "list"])
  return parseAgentStatus(output, paneId)
}

const tryWaitAgentStatus = async (paneId: string, status: string, timeoutMs: number) => {
  const { code } = await tryRunHerdr([...waitAgentStatusArgs(paneId, status, timeoutMs)])
  return code === 0
}

const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => {
    setTimeout(resolve, ms)
  })

export type StatusWaitDeps = {
  eventChunkMs: number
  now: () => number
  pollIntervalMs: number
  readStatus: (paneId: string) => Promise<string | undefined>
  sleep: (ms: number) => Promise<void>
  tryWait: (paneId: string, status: string, timeoutMs: number) => Promise<boolean>
}

export const defaultStatusWaitDeps = (): StatusWaitDeps => ({
  eventChunkMs: EVENT_CHUNK_MS,
  now: () => Date.now(),
  pollIntervalMs: POLL_INTERVAL_MS,
  readStatus: readAgentStatus,
  sleep,
  tryWait: tryWaitAgentStatus,
})

const formatTargetStatuses = (targets: readonly string[]) =>
  targets.length === 1 ? `"${targets[0]}"` : `[${targets.join(", ")}]`

const matchesTargetStatus = (status: string | undefined, targets: readonly string[]) =>
  status !== undefined && targets.includes(status)

export const waitForAgentStatusEvent = async (
  paneId: string,
  target: string | readonly string[],
  timeoutMs: number,
): Promise<void> => {
  await runHerdr(waitAgentStatusArgs(paneId, target, timeoutMs))
}

export const waitForAgentStatusWithPolling = async (
  paneId: string,
  target: string | readonly string[],
  timeoutMs: number,
  deps: StatusWaitDeps = defaultStatusWaitDeps(),
): Promise<void> => {
  const targets = normalizeTargetStatuses(target)
  const deadline = deps.now() + timeoutMs
  const targetLabel = formatTargetStatuses(targets)

  while (deps.now() < deadline) {
    const status = await deps.readStatus(paneId)
    console.log(
      `[Agent] Polling pane ${paneId}: agent_status=${status ?? "(missing)"}, target=${targetLabel}`,
    )
    if (matchesTargetStatus(status, targets)) return

    const remaining = deadline - deps.now()
    if (remaining <= 0) break

    const chunkMs = Math.min(deps.eventChunkMs, remaining)
    if (chunkMs > 0) {
      for (const targetStatus of targets) {
        if (await deps.tryWait(paneId, targetStatus, chunkMs)) return
      }
    }

    const sleepMs = Math.min(deps.pollIntervalMs, deadline - deps.now())
    if (sleepMs > 0) await deps.sleep(sleepMs)
  }

  throw new Error(
    `[Agent] Timed out waiting for pane ${paneId} to reach status ${targetLabel} after ${timeoutMs}ms`,
  )
}

export const waitForAgentStatus = async (
  paneId: string,
  target: string | readonly string[],
  timeoutMs: number,
  deps: StatusWaitDeps = defaultStatusWaitDeps(),
): Promise<void> => {
  if (POLLING_FALLBACK_ENABLED) {
    return waitForAgentStatusWithPolling(paneId, target, timeoutMs, deps)
  }

  return waitForAgentStatusEvent(paneId, target, timeoutMs)
}
