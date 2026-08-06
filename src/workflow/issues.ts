import { readFile } from "node:fs/promises"

import {
  bootstrapSession,
  runAgentIntegration,
  runAgentUpdate,
  sendTaskAndMonitor,
  startAgentResumed,
  stopAgent,
} from "../agent/index.js"
import type { OutputCallback } from "../agent/index.js"
import { deduplicateAgentIntegrations } from "../agent/integration.js"
import { deduplicateAgentUpdates } from "../agent/update.js"
import type { AgentSessionHandle } from "../agent/transcript/types.js"
import { createSession } from "../agent/session.js"
import { markIssueFinished, markIssueInReview } from "../config/persist.js"
import type { IssueConfig } from "../types.js"
import { render } from "../lib/utils.js"
import { parseStatus } from "../lib/status-parser.js"
import { notifyIssueComplete } from "../notify/index.js"
import { handleNeedsInputGate, ensureStatusRetry, defaultImplementAskDeps, type ImplementAskDeps } from "./implement-ask.js"
import { createFinalSessionDir, runFinalGate } from "./final-gate.js"
import { advanceBaseline } from "./review-context.js"
import { runReviewLoop } from "./review-loop.js"
import type { WorkflowRuntime } from "./types.js"

export const shouldSkipIssue = (issue: IssueConfig) => (issue.state ?? "ready") === "finish"
export const shouldSkipImplement = (issue: IssueConfig) => (issue.state ?? "ready") === "review"
export const shouldNotifyIssueComplete = (index: number, issueCount: number) =>
  index < issueCount - 1

const ensureImplementerSession = async (runtime: WorkflowRuntime) => {
  if (runtime.implementerPane) return
  if (!runtime.implementerSession) {
    runtime.implementerSession = await bootstrapSession(runtime.config.agents.implementer)
  }
  runtime.implementerPane = await startAgentResumed(
    runtime.config.projectDir,
    runtime.config.agents.implementer,
    runtime.implementerSession.resumeId,
    { ensureUniqueName: true },
  )
  // 不再等待 Herdr 状态：Agent 启动后直接发 task，monitor 以 JSONL 首次事件确认为准
}

/**
 * 处理 implementer 的 STATUS 输出直到终态（IMPLEMENT_DONE / 抛错）。
 *
 * - IMPLEMENT_ASK → 门卫；用户 yes 后重新解析，可能再次 ASK/FAILED → 循环
 * - IMPLEMENT_FAILED → 终止 workflow
 * - 无 STATUS → 重试补标记
 */
const settleImplementer = async (
  runtime: WorkflowRuntime,
  initialOutput: string,
  initialStatus: string,
  sh: AgentSessionHandle,
  depsWithBus: ImplementAskDeps,
  issue: IssueConfig,
) => {
  let currentOutput = initialOutput
  let currentStatus = initialStatus

  while (true) {
    const parsed = parseStatus(currentOutput, "implementer")

    // 原生提问（monitor 级）→ 通用门卫，再次展示 yes/no
    if (currentStatus === "needs_input") {
      const reason = "Agent 需要人工处理"
      runtime.eventBus.publish({ type: "agent_state_change", agent: "implementer", status: "needs_input" })
      runtime.eventBus.publish({ type: "needs_input", agent: "implementer", provider: sh.provider, reason })
      runtime.eventBus.publish({ type: "pause", reason: `implementer needs_input: ${reason}` })
      const gated = await handleNeedsInputGate(
        "implementer", runtime.implementerPane, "implement", sh,
        depsWithBus, reason,
      )
      runtime.eventBus.publish({ type: "agent_state_change", agent: "implementer", status: "working" })
      currentOutput = gated.finalText
      currentStatus = gated.status
      continue
    }

    if (parsed.status === "IMPLEMENT_ASK") {
      const reason = "Agent 需要人工处理"
      runtime.eventBus.publish({ type: "agent_state_change", agent: "implementer", status: "needs_input" })
      runtime.eventBus.publish({ type: "needs_input", agent: "implementer", provider: sh.provider, reason })
      runtime.eventBus.publish({ type: "pause", reason: `implementer needs_input: ${reason}` })
      const gated = await handleNeedsInputGate(
        "implementer", runtime.implementerPane, "implement", sh,
        depsWithBus, reason,
      )
      runtime.eventBus.publish({ type: "agent_state_change", agent: "implementer", status: "working" })
      currentOutput = gated.finalText
      currentStatus = gated.status
      continue
    }

    if (parsed.status === "IMPLEMENT_FAILED") {
      runtime.eventBus.publish({ type: "agent_state_change", agent: "implementer", status: "failed" })
      runtime.eventBus.publish({ type: "fail", reason: "Implementer reported IMPLEMENT_FAILED" })
      throw new Error(`[Implement] Implementer failed for issue "${issue.title}". Stopping workflow.`)
    }

    if (!parsed.status) {
      // 无 STATUS 标记 → 重试补标记；补标记后可能又 needs_input，循环处理
      const retried = await ensureStatusRetry("implementer", runtime.implementerPane, currentOutput, "implement", sh, depsWithBus)
      currentOutput = retried.finalText
      currentStatus = retried.status
      continue
    }

    // IMPLEMENT_DONE → 完成
    runtime.eventBus.publish({ type: "agent_state_change", agent: "implementer", status: "completed" })
    return
  }
}

const runSingleSpecCycle = async (
  runtime: WorkflowRuntime,
  configPath: string,
  issue: IssueConfig,
  issueIndex: number,
  issues: IssueConfig[],
) => {
  const { specPath } = issue
  const specContent = await readFile(specPath, "utf8")
  const configContent = await readFile(configPath, "utf8")
  const { sessionDir: specSessionDir } = await createSession(
    runtime.config.projectDir, configPath, configContent, specPath, specContent, runtime.args,
  )
  console.log(`[Session] Session: ${specSessionDir}`)

  if (shouldSkipImplement(issue)) {
    console.log(`[Implement] Skipping (state=review): ${issue.title}`)
    // 不预启动 implementer，review 需要修复时再按需启动
  } else {
    await ensureImplementerSession(runtime)
    const sh = runtime.implementerSession!
    runtime.eventBus.publish({ type: "phase_change", phase: "implement" })
    runtime.eventBus.publish({ type: "agent_state_change", agent: "implementer", status: "working" })

    const { finalText, status: monitorStatus, question, reason: failReasonFromMonitor } = await sendTaskAndMonitor(
      runtime.implementerPane,
      render(runtime.prompts.implement, {
        maxReviewRounds: String(runtime.config.maxRounds.workflow),
        specPath,
      }),
      sh,
    )

    const depsWithBus = { ...defaultImplementAskDeps(), eventBus: runtime.eventBus }

    // 先检查 monitor 级状态，再解析 STATUS 标记
    if (monitorStatus === "needs_input" || monitorStatus === "failed") {
      if (monitorStatus === "failed") {
        // P2-4: 优先使用 lastEvent.reason（Claude/Codex 失败原因），其次 question，最后兜底
        const failReason = failReasonFromMonitor ?? question ?? "unknown error"
        runtime.eventBus.publish({ type: "agent_state_change", agent: "implementer", status: "failed" })
        runtime.eventBus.publish({ type: "fail", reason: `Implementer failed: ${failReason}` })
        throw new Error(`[Implement] Implementer failed for issue "${issue.title}". Stopping workflow.`)
      }
      // monitor 级 needs_input（原生提问）→ 门卫 + settle 循环
      const reason = question ?? "需要人工确认"
      runtime.eventBus.publish({ type: "agent_state_change", agent: "implementer", status: "needs_input" })
      runtime.eventBus.publish({ type: "needs_input", agent: "implementer", provider: sh.provider, reason })
      runtime.eventBus.publish({ type: "pause", reason: `implementer needs_input: ${reason}` })
      await settleImplementer(runtime, finalText, monitorStatus, sh, depsWithBus, issue)
    } else {
      // monitor 状态正常，解析 STATUS 标记
      await settleImplementer(runtime, finalText, monitorStatus, sh, depsWithBus, issue)
    }
  }

  await markIssueInReview(configPath, issueIndex, issues)
  runtime.reviewerSession = await bootstrapSession(runtime.config.agents.reviewer)

  await runReviewLoop(runtime, 1, specSessionDir, specPath)
}

export const runIssueQueueFromIndex = async (
  runtime: WorkflowRuntime,
  configPath: string,
  startIndex: number,
  issues: IssueConfig[],
) => {
  // 仅在整个 issue 队列结束后发布 workflow complete
  const publishCompleteWhenDone = () => {
    runtime.eventBus.publish({ type: "complete" })
  }

  for (let index = startIndex; index < issues.length; index += 1) {
    const issue = issues[index]
    console.log(`\n[Issue] === Issue ${index + 1}/${issues.length}: ${issue.title} ===`)
    console.log(`[Issue] Spec path: ${issue.specPath}`)

    if (shouldSkipIssue(issue)) {
      console.log(`[Issue] Skipping (state=finish): ${issue.title}`)
      continue
    }

    runtime.issueIndex = index
    runtime.eventBus.publish({ type: "issue_change", issueIndex: index, issueCount: issues.length, issueTitle: issue.title })

    if (runtime.implementerPane) { await stopAgent(runtime.implementerPane); runtime.implementerPane = "" }
    if (runtime.reviewerPane) { await stopAgent(runtime.reviewerPane); runtime.reviewerPane = "" }
    runtime.implementerSession = undefined
    runtime.reviewerSession = undefined

    try {
      await runSingleSpecCycle(runtime, configPath, issue, index, issues)
      await advanceBaseline(runtime)
      await markIssueFinished(configPath, index, issues)
      if (shouldNotifyIssueComplete(index, issues.length)) {
        notifyIssueComplete(issue.title)
      }
    } finally {
      const ip = runtime.implementerPane
      const rp = runtime.reviewerPane
      if (ip) { runtime.implementerPane = ""; await stopAgent(ip).catch(() => {}) }
      if (rp) { runtime.reviewerPane = ""; await stopAgent(rp).catch(() => {}) }
    }
  }

  // 所有 issue 成功完成：若启用 final gate 则先做全局审查，通过后才发布 workflow complete
  if (runtime.config.enableFinalGate) {
    const finalSessionDir = await createFinalSessionDir(runtime)
    await runFinalGate(runtime, finalSessionDir)
  }

  publishCompleteWhenDone()
}

/** 将子进程输出通过 console 重定向到 log sink */
const agentOutput: OutputCallback = (msg, stream) => {
  if (stream === "stderr") console.warn(msg); else console.log(msg)
}

export const runIssueQueue = async (runtime: WorkflowRuntime, configPath: string) => {
  const { agents, projectDir } = runtime.config
  // 仅在 final gate 启用时为 final 角色执行 update / integration；禁用时不产生额外命令
  const finalRoles = runtime.config.enableFinalGate
    ? [agents.gateReviewer!, agents.gateFixer!]
    : []
  const allAgents = [agents.implementer, agents.reviewer, ...finalRoles]
  const updateAgents = deduplicateAgentUpdates(allAgents)
  const integrationAgents = deduplicateAgentIntegrations(allAgents)
  await Promise.all([
    ...updateAgents.map((agent) => runAgentUpdate(projectDir, agent, agentOutput)),
    ...integrationAgents.map((agent) => runAgentIntegration(agent, agentOutput)),
  ])
  await runIssueQueueFromIndex(runtime, configPath, 0, runtime.config.issues)
}
