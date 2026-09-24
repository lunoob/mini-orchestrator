import { access } from "node:fs/promises"
import { mkdir } from "node:fs/promises"

import { sendTaskAndMonitor } from "../agent/index.js"
import { getHeadShaSafe } from "../git/index.js"
import { render } from "../lib/utils.js"
import { handleMonitorResult } from "./review-loop.js"
import type { WorkflowRuntime } from "./types.js"
import { getAcceptanceReportPath, getWorkflowOrchestratorDir } from "./workflow-dir.js"

export type AcceptanceSessionSource = "gateReviewer" | "issueReviewer"

const formatSpecList = (runtime: WorkflowRuntime) =>
  runtime.config.issues
    .map((issue, index) => `- Issue ${index + 1}: ${issue.title} (spec: ${issue.specPath})`)
    .join("\n")

export const shouldRunAcceptance = (runtime: WorkflowRuntime) => {
  if (!runtime.config.enableAcceptanceReport) return false
  if (runtime.config.enableFinalGate) return true
  return runtime.config.issues.length === 1
}

export const runAcceptance = async (runtime: WorkflowRuntime, source: AcceptanceSessionSource) => {
  const pane = source === "gateReviewer" ? runtime.finalReviewerPane : runtime.reviewerPane
  const session = source === "gateReviewer" ? runtime.finalReviewerSession : runtime.reviewerSession
  if (!pane || !session) {
    throw new Error(`[Acceptance] Missing ${source} pane or session`)
  }

  const reportPath = getAcceptanceReportPath(runtime.config.projectDir, runtime.configPath)
  await mkdir(getWorkflowOrchestratorDir(runtime.config.projectDir, runtime.configPath), { recursive: true })

  const headSha = runtime.hasGit
    ? (await getHeadShaSafe(runtime.config.projectDir)) ?? "N/A"
    : "N/A"

  runtime.eventBus.publish({ type: "phase_change", phase: "acceptance" })
  runtime.eventBus.publish({ type: "agent_state_change", agent: "reviewer", status: "working" })

  const { finalText, status, question } = await sendTaskAndMonitor(
    pane,
    render(runtime.prompts.acceptance, {
      generatedAt: new Date().toISOString(),
      headSha,
      reportPath,
      specs: formatSpecList(runtime),
      title: runtime.config.title ?? runtime.config.issues[0]?.title ?? "Workflow",
    }),
    session,
  )

  await handleMonitorResult(
    "reviewer", pane, finalText, status, question,
    "acceptance", session, runtime.eventBus, runtime.config.title,
  )

  try {
    await access(reportPath)
  } catch {
    runtime.eventBus.publish({ type: "fail", reason: "Acceptance report file was not created" })
    throw new Error(`[Acceptance] Report file not found: ${reportPath}`)
  }

  console.log(`[Acceptance] Report written: ${reportPath}`)
  runtime.eventBus.publish({ type: "agent_state_change", agent: "reviewer", status: "completed" })
}
