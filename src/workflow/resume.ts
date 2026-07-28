import path from "node:path"

import { readNeedsCheckCheckpoint } from "../review/checkpoint.js"
import { loadConfig, loadPrompts } from "../config/load.js"
import { parseNeedsCheckAction, parseNeedsCheckMode } from "../review/needs-check.js"
import { createSessionApiServer } from "../session/server.js"
import { createSessionClient } from "../session/client.js"
import type { ParsedArgs } from "../types.js"
import { sendControllerRevise, runReviewLoop } from "./review-loop.js"
import { advanceBaseline } from "./review-context.js"
import { runIssueQueueFromIndex } from "./issues.js"
import { markIssueFinished } from "../config/persist.js"
import type { WorkflowRuntime } from "./types.js"
import { startRuntimeAgents, stopRuntimeAgents } from "./agent-runtime.js"

export const runWorkflowResume = async (args: ParsedArgs) => {
  const checkpointPath = path.resolve(args["resume-from"])
  const sessionDir = path.dirname(checkpointPath)
  const checkpoint = await readNeedsCheckCheckpoint(checkpointPath)

  const action = parseNeedsCheckAction(args["needs-check-action"])
  const notes = (args["needs-check-notes"] ?? "").trim()
  if ((action === "revise" || action === "retry-review") && !notes) {
    throw new Error(`[Resume] --needs-check-notes is required for action: ${action}`)
  }

  const configPath = path.resolve(args.config ?? checkpoint.configPath)
  const config = await loadConfig(configPath, args)
  const configDir = path.dirname(configPath)
  const prompts = await loadPrompts(config, configDir)
  const sessionServer = createSessionApiServer({ runDirectory: path.join(config.projectDir, ".orchestrator") })
  const { baseUrl, token } = await sessionServer.start()

  const currentIndex = checkpoint.currentIssueIndex

  const runtime: WorkflowRuntime = {
    args: { ...args },
    baseSha: checkpoint.baseSha,
    config,
    hasGit: checkpoint.hasGit,
    implementerPane: checkpoint.implementerPane,
    issueIndex: currentIndex,
    needsCheckMode: parseNeedsCheckMode(args),
    prompts,
    reviewerPane: checkpoint.reviewerPane,
    sessionBaseUrl: baseUrl,
    sessionClient: createSessionClient({ baseUrl, token }),
  }

  delete runtime.args["resume-from"]
  delete runtime.args["needs-check-action"]
  delete runtime.args["needs-check-notes"]

  console.log(`[Resume] Resuming from checkpoint: ${checkpointPath}`)
  console.log(`[Resume] Needs-check action: ${action}`)

  const currentIssue = checkpoint.issues[currentIndex]

  if (!currentIssue) {
    await sessionServer.stop()
    throw new Error(`[Resume] Invalid checkpoint: issue index ${currentIndex} out of range`)
  }

  try {
    await startRuntimeAgents(runtime, sessionDir)
    switch (action) {
    case "approve":
      console.log(`[Issue] Issue approved: ${currentIssue.title}`)
      await markIssueFinished(configPath, currentIndex, checkpoint.issues)
      if (currentIndex + 1 < checkpoint.issues.length) {
        await advanceBaseline(runtime)
        await runIssueQueueFromIndex(runtime, configPath, currentIndex + 1, checkpoint.issues)
        return
      }
      await stopRuntimeAgents(runtime)
      console.log("\n[Issue] Workflow finished: all issues manually approved.")
      return
    case "abort":
      throw new Error(`[Resume] Workflow aborted after needs_check in round ${checkpoint.round}.`)
    case "revise":
      await sendControllerRevise(runtime, checkpoint.round, notes, checkpoint.reviewOutput)
      await runReviewLoop(runtime, configPath, checkpoint.round + 1, checkpoint.reuseCurrentPane, sessionDir, currentIssue.specPath, currentIndex, checkpoint.issues)
      await markIssueFinished(configPath, currentIndex, checkpoint.issues)
      if (currentIndex + 1 < checkpoint.issues.length) {
        await advanceBaseline(runtime)
        await runIssueQueueFromIndex(runtime, configPath, currentIndex + 1, checkpoint.issues)
        return
      }
      await stopRuntimeAgents(runtime)
      return
    case "retry-review":
      await runReviewLoop(runtime, configPath, checkpoint.round, checkpoint.reuseCurrentPane, sessionDir, currentIssue.specPath, currentIndex, checkpoint.issues, { controllerReviewNotes: notes, lastReviewOutput: checkpoint.reviewOutput })
      await markIssueFinished(configPath, currentIndex, checkpoint.issues)
      if (currentIndex + 1 < checkpoint.issues.length) {
        await advanceBaseline(runtime)
        await runIssueQueueFromIndex(runtime, configPath, currentIndex + 1, checkpoint.issues)
        return
      }
      await stopRuntimeAgents(runtime)
      return
    default: {
      const _exhaustive: never = action
      throw new Error(`[Resume] Unknown needs-check action: ${_exhaustive}`)
    }
    }
  } finally {
    await stopRuntimeAgents(runtime)
    await sessionServer.stop()
  }
}
