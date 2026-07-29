import { randomUUID } from "node:crypto"

import { getErrorMessage } from "../lib/utils.js"
import { startWorkflowAgent, type WorkflowAgent } from "../session/workflow-agent.js"
import { waitForTurn } from "../session/turn-wait.js"
import type { WorkflowRuntime } from "./types.js"

type CheckpointSessionRefs = {
  implementerSessionId: string
  reviewerSessionId: string
}

/** 清理失败不被抛出，避免覆盖 finally 块中保留的原始工作流异常。 */
export const stopRuntimeAgents = async (runtime: WorkflowRuntime) => {
  const errors: Array<{ label: string; error: unknown }> = []

  const stopOne = async (session: WorkflowAgent | undefined, label: string) => {
    if (!session) return
    try {
      await session.stop()
    } catch (error) {
      errors.push({ error, label })
      console.warn(`[Workflow] ${label} session cleanup error:`, getErrorMessage(error))
    }
  }

  await Promise.all([
    stopOne(runtime.implementerSession, "implementer"),
    stopOne(runtime.reviewerSession, "reviewer"),
  ])

  runtime.implementerSession = undefined
  runtime.reviewerSession = undefined

  if (errors.length > 0) {
    console.warn(
      `[Workflow] ${errors.length} cleanup error(s) occurred during agent stop: ` +
        errors.map(e => e.label).join(", "),
    )
  }
}

/**
 * 尝试重连既有 session；若 session 已不存在或 runner 已失效，新建 session 并记录迁移路径。
 * pane 由 Session supervisor 内部管理，workflow 侧不可见。
 */
const reconnectOrCreateAgent = async (
  runtime: WorkflowRuntime,
  role: "implementer" | "reviewer",
  sessionId: string | undefined,
  runDirectory: string,
) => {
  let existing: Awaited<ReturnType<typeof runtime.sessionClient.get>> | undefined
  if (sessionId) {
    try {
      existing = await runtime.sessionClient.get(sessionId)
      // runner 与 session 必须同时在可接收消息的状态才可复用
      const canReconnect = existing?.runnerReady &&
        (existing.status === "ready" || existing.status === "idle")
      if (canReconnect) {
        const reconnected = existing
        console.log(`[Resume] Reconnecting to existing ${role} session: ${sessionId} (status=${reconnected.status})`)
        return {
          sessionId: reconnected.id,
          sendTaskAndWait: async (prompt: string) => {
            const { turnId } = await runtime.sessionClient.sendMessage(reconnected.id, {
              content: prompt,
              eventId: randomUUID(),
            })
            const result = await waitForTurn(runtime.sessionClient, reconnected.id, turnId)
            if (result.turn.status !== "completed") {
              throw new Error(
                `[Session] Turn ${turnId} ended with status ${result.turn.status}${result.turn.error ? `: ${result.turn.error}` : ""}`,
              )
            }
            return result.output?.content ?? result.turn.outputText ?? ""
          },
          stop: async () => {
            // 复用 session 关闭：发送 stop 事件，不强制关闭 pane（pane 可能已不存在）
            try {
              await runtime.sessionClient.postEvent(reconnected.id, {
                eventId: `stop-resume-${reconnected.id}`,
                type: "stop",
              })
            } catch {
              // pane 已失效时忽略
            }
          },
        } as WorkflowAgent
      }
    } catch {
      // session 不存在或获取失败：走新建路径
    }
  }

  // runner 失效 / session 已终止 / 不存在：新建并记录
  const reason = sessionId
    ? `runnerReady=${existing?.runnerReady ?? false} status=${existing?.status ?? "missing"}`
    : "not found"
  console.log(
    `[Resume] ${role} session ${sessionId ?? "unknown"} cannot reconnect (${reason}) — creating new session`,
  )
  const agentConfig =
    role === "implementer" ? runtime.config.implementer : runtime.config.reviewer
  return startWorkflowAgent({
    agent: agentConfig,
    baseUrl: runtime.sessionBaseUrl,
    client: runtime.sessionClient,
    projectDir: runtime.config.projectDir,
    role,
    runDirectory,
  })
}

/**
 * 启动 runtime agent；若提供 checkpoint session 信息，优先重连既有 session，
 * 否则（或重连失败时）创建新 session。
 */
export const startRuntimeAgents = async (
  runtime: WorkflowRuntime,
  runDirectory: string,
  checkpointRefs?: CheckpointSessionRefs,
) => {
  await stopRuntimeAgents(runtime)
  try {
    // 顺序启动：每创建/重连成功一个 session 立即写入 runtime，
    // 确保后续若另一侧失败时 catch 中的 cleanup 能停止已启动的 session。
    runtime.implementerSession = await reconnectOrCreateAgent(
      runtime,
      "implementer",
      checkpointRefs?.implementerSessionId,
      runDirectory,
    )
    runtime.reviewerSession = await reconnectOrCreateAgent(
      runtime,
      "reviewer",
      checkpointRefs?.reviewerSessionId,
      runDirectory,
    )
  } catch (error) {
    await stopRuntimeAgents(runtime)
    throw error
  }
}
