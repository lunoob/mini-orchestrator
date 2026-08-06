import { createHash } from "node:crypto"
import { readFile, mkdir } from "node:fs/promises"
import path from "node:path"

import {
  bootstrapSession,
  sendTaskAndMonitor,
  startAgentResumed,
  stopAgent,
} from "../agent/index.js"
import type { AgentSessionHandle } from "../agent/transcript/types.js"
import { extractStatusSummary, printSection, render, stripStatus } from "../lib/utils.js"
import { parseStatus } from "../lib/status-parser.js"
import { buildDiffFileSection, prepareReviewContext } from "./review-context.js"
import { handleMonitorResult, handleNeedsCheck } from "./review-loop.js"
import type { WorkflowRuntime } from "./types.js"
import type { AgentConfig } from "../types.js"

/**
 * Final Gate：全部 issue 完成后，Final Reviewer 对合并结果做全局审查，
 * REVIEW_FAIL 时由 Final Fixer 修复并重新审查，直到通过或达到 maxRounds。
 *
 * 复用现有 STATUS 协议（REVIEW_ 系列 / IMPLEMENT_ 系列）、人工确认 gate 与 pane 生命周期，
 * 不引入 issue 归属判断。返回即表示通过，workflow complete 由上层发布。
 */

/** 全部 issue 的标题 + specPath 列表（Final Reviewer 输入） */
const formatSpecList = (runtime: WorkflowRuntime) =>
  runtime.config.issues
    .map((issue, index) => `- Issue ${index + 1}: ${issue.title} (spec: ${issue.specPath})`)
    .join("\n")

/** 全部 issue 的 spec 路径列表（Final Fixer 输入） */
const formatSpecPaths = (runtime: WorkflowRuntime) =>
  runtime.config.issues.map((issue) => `- ${issue.specPath}`).join("\n")

/**
 * 基于 config 与全部 spec 内容创建稳定的 final session 目录，
 * 只用于 review package / 运行记录，不保存 final round 或 review 输出。
 */
export const createFinalSessionDir = async (runtime: WorkflowRuntime): Promise<string> => {
  const configPath = path.resolve(runtime.configPath)
  const configContent = await readFile(configPath, "utf8")
  const specs = await Promise.all(
    runtime.config.issues.map(async (issue) => ({
      path: path.resolve(issue.specPath),
      content: await readFile(issue.specPath, "utf8"),
    })),
  )
  const cliArgs = Object.entries(runtime.args)
    .filter(([key]) => key !== "help")
    .sort(([a], [b]) => a.localeCompare(b))

  const hash = createHash("sha256")
    .update(JSON.stringify({ configPath, configContent, specs, cliArgs }))
    .digest("hex")
    .slice(0, 8)

  const sessionDir = path.join(runtime.config.projectDir, ".orchestrator", `final-${hash}`)
  await mkdir(sessionDir, { recursive: true })
  return sessionDir
}

/** 按需启动 Final Reviewer session + pane */
const ensureFinalReviewer = async (runtime: WorkflowRuntime, agent: AgentConfig): Promise<AgentSessionHandle> => {
  if (runtime.finalReviewerPane) return runtime.finalReviewerSession!
  if (!runtime.finalReviewerSession) {
    runtime.finalReviewerSession = await bootstrapSession(agent)
  }
  runtime.finalReviewerPane = await startAgentResumed(
    runtime.config.projectDir, agent,
    runtime.finalReviewerSession, { ensureUniqueName: true },
  )
  console.log(`[FinalGate] Started final reviewer on demand: ${runtime.finalReviewerPane}`)
  return runtime.finalReviewerSession
}

/** 按需启动 Final Fixer session + pane */
const ensureFinalFixer = async (runtime: WorkflowRuntime, agent: AgentConfig): Promise<AgentSessionHandle> => {
  if (runtime.finalFixerPane) return runtime.finalFixerSession!
  if (!runtime.finalFixerSession) {
    runtime.finalFixerSession = await bootstrapSession(agent)
  }
  runtime.finalFixerPane = await startAgentResumed(
    runtime.config.projectDir, agent,
    runtime.finalFixerSession, { ensureUniqueName: true },
  )
  console.log(`[FinalGate] Started final fixer on demand: ${runtime.finalFixerPane}`)
  return runtime.finalFixerSession
}

/** 发布 fail 并抛错终止 final gate */
const failWithError = (runtime: WorkflowRuntime, message: string): never => {
  runtime.eventBus.publish({ type: "fail", reason: message })
  throw new Error(`[FinalGate] ${message}`)
}

const publishReviewerNeedsCheck = (runtime: WorkflowRuntime) => {
  runtime.eventBus.publish({ type: "agent_state_change", agent: "reviewer", status: "needs_input" })
  runtime.eventBus.publish({ type: "needs_input", agent: "reviewer", provider: runtime.finalReviewerSession!.provider, reason: "Review 需要人工核查" })
  runtime.eventBus.publish({ type: "pause", reason: "reviewer needs_check" })
}

/**
 * 执行一轮 final review：输入为全部 issue 的 spec、workflow 起始 baseline 到
 * 当前 HEAD 的完整 diff、当前 round，以及第 2 轮起上一轮 review 的正文。
 */
const conductFinalReview = async (
  runtime: WorkflowRuntime, round: number, sessionDir: string, lastReviewOutput?: string,
) => {
  const session = runtime.finalReviewerSession!
  const maxRounds = runtime.config.maxRounds.finalGate

  runtime.eventBus.publish({ type: "review_round_change", round, maxRounds })
  runtime.eventBus.publish({ type: "agent_state_change", agent: "reviewer", status: "working" })

  const reviewContext = await prepareReviewContext(sessionDir, runtime.config.projectDir, runtime.startBaseSha, round)
  if (reviewContext.diffFile) console.log(`[FinalGate] Review package: ${reviewContext.diffFile}`)

  const diffFileSection = buildDiffFileSection(reviewContext.diffFile, !runtime.hasGit)
  const lastReviewSection = lastReviewOutput
    ? ["", "## 上一轮 final review 的正文（供参考）", "", "<issue>", lastReviewOutput, "</issue>"].join("\n")
    : ""

  const { finalText, status, question } = await sendTaskAndMonitor(
    runtime.finalReviewerPane,
    render(runtime.prompts.finalReview, {
      baseSha: reviewContext.baseSha,
      diffFileSection,
      headSha: reviewContext.headSha,
      lastReviewSection,
      round: String(round),
      specs: formatSpecList(runtime),
    }),
    session,
  )

  const final = await handleMonitorResult(
    "reviewer", runtime.finalReviewerPane, finalText, status, question,
    `final review round ${round}`, session, runtime.eventBus,
  )

  const parsed = parseStatus(final, "reviewer")
  printSection(`Final Review Round ${round}`, extractStatusSummary(final, "reviewer") || "(no status)")

  if (parsed.status === "REVIEW_PASS" || parsed.status === "REVIEW_FAIL") {
    runtime.eventBus.publish({ type: "agent_state_change", agent: "reviewer", status: "completed" })
  } else if (parsed.status === "REVIEW_NEEDS_CHECK") {
    publishReviewerNeedsCheck(runtime)
  }

  return { reviewOutput: final, parsed }
}

/** 执行 Final Fixer：输入为去 STATUS 行的问题清单、当前 round、全部 spec 路径 */
const runFinalFixer = async (runtime: WorkflowRuntime, reviewOutput: string, round: number) => {
  const session = await ensureFinalFixer(runtime, runtime.config.agents.gateFixer!)

  runtime.eventBus.publish({ type: "phase_change", phase: "final-fix" })
  runtime.eventBus.publish({ type: "agent_state_change", agent: "implementer", status: "working" })

  const { finalText, status, question } = await sendTaskAndMonitor(
    runtime.finalFixerPane,
    render(runtime.prompts.finalFix, {
      reviewOutput: stripStatus(reviewOutput, "reviewer"),
      round: String(round),
      specPaths: formatSpecPaths(runtime),
    }),
    session,
  )

  await handleMonitorResult(
    "implementer", runtime.finalFixerPane, finalText, status, question,
    `final fix round ${round}`, session, runtime.eventBus,
  )

  runtime.eventBus.publish({ type: "agent_state_change", agent: "implementer", status: "completed" })
}

/**
 * REVIEW_NEEDS_CHECK 门卫循环：用户 yes 后 Final Reviewer 重审，
 * PASS → 通过；FAIL → 未达上限则转 Final Fixer；超限 → 失败退出。
 */
const settleFinalNeedsCheck = async (
  runtime: WorkflowRuntime, round: number, initialOutput: string,
): Promise<"passed" | { reviewOutput: string }> => {
  const maxRounds = runtime.config.maxRounds.finalGate
  let needsCheckOutput = initialOutput
  let checks = 0

  while (true) {
    checks += 1
    if (checks > maxRounds) {
      failWithError(runtime, `Final review needs_check exceeded ${maxRounds} rounds`)
    }

    const decision = await handleNeedsCheck(
      runtime, round, runtime.finalReviewerSession!, runtime.finalReviewerPane,
    )
    needsCheckOutput = decision.finalText ?? ""
    const reParsed = parseStatus(needsCheckOutput, "reviewer")

    if (reParsed.status === "REVIEW_PASS") return "passed"
    if (reParsed.status === "REVIEW_FAIL") {
      if (round === maxRounds) {
        failWithError(runtime, `Final review failed after ${maxRounds} rounds`)
      }
      await runFinalFixer(runtime, needsCheckOutput, round)
      return { reviewOutput: needsCheckOutput }
    }

    // 仍 NEEDS_CHECK：重新发布事件，用户再处理
    publishReviewerNeedsCheck(runtime)
  }
}

export const runFinalGate = async (runtime: WorkflowRuntime, sessionDir: string) => {
  if (!runtime.config.enableFinalGate) return

  try {
    await ensureFinalReviewer(runtime, runtime.config.agents.gateReviewer!)
    let lastReviewOutput: string | undefined

    for (let round = 1; round <= runtime.config.maxRounds.finalGate; round += 1) {
      runtime.eventBus.publish({ type: "phase_change", phase: "final-review" })

      const { reviewOutput, parsed } = await conductFinalReview(runtime, round, sessionDir, lastReviewOutput)
      lastReviewOutput = stripStatus(reviewOutput, "reviewer")

      // REVIEW_PASS → 直接成功，不调用局部 post-review-check；complete 由顶层发布
      if (parsed.status === "REVIEW_PASS") return

      // REVIEW_NEEDS_CHECK → 人工核查 gate；FAIL 同样转 Final Fixer
      if (parsed.status === "REVIEW_NEEDS_CHECK") {
        const outcome = await settleFinalNeedsCheck(runtime, round, reviewOutput)
        if (outcome === "passed") return
        lastReviewOutput = stripStatus(outcome.reviewOutput, "reviewer")
        continue
      }

      // REVIEW_FAIL → 未达上限则交给 Final Fixer，进入下一轮
      if (round === runtime.config.maxRounds.finalGate) {
        failWithError(runtime, `Final review failed after ${runtime.config.maxRounds.finalGate} rounds`)
      }
      await runFinalFixer(runtime, reviewOutput, round)
    }

    failWithError(runtime, `Final review failed after ${runtime.config.maxRounds.finalGate} rounds`)
  } finally {
    // 只关闭由 final gate 启动的 pane
    const fp = runtime.finalFixerPane
    const rp = runtime.finalReviewerPane
    if (fp) { runtime.finalFixerPane = ""; await stopAgent(fp).catch(() => {}) }
    if (rp) { runtime.finalReviewerPane = ""; await stopAgent(rp).catch(() => {}) }
  }
}
