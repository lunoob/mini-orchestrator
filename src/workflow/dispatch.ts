import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"

import { readAgentOutputWithRetry, sendTask } from "../agent/index.js"
import {
  IMPLEMENT_RESULT_END,
  IMPLEMENT_RESULT_START,
  REVIEW_RESULT_END,
  REVIEW_RESULT_START,
} from "../lib/prompt-delimiters.js"
import type { TaskFile, TaskRole } from "../types.js"
import { createTask, buildTaskProtocol, waitForTaskCompleted } from "../task/index.js"
import { extractReviewResult, parseReviewVerdict, type ReviewVerdict } from "../lib/utils.js"

const orchestratorMain = fileURLToPath(new URL("../main.ts", import.meta.url))

export const buildRunId = (issueIndex: number, role: TaskRole, round: number, subtype = "") => {
  const suffix = randomUUID()
  const base = `${issueIndex}-${role}-r${round}`
  return subtype ? `${base}-${subtype}-${suffix}` : `${base}-${suffix}`
}

export const waitForOutputAfterCompletion = async (
  paneId: string,
  role: TaskRole,
  delayMs = 5000,
  readFn: typeof readAgentOutputWithRetry = readAgentOutputWithRetry,
) => {
  await new Promise(resolve => setTimeout(resolve, delayMs))

  const delimiterStart = role === "implementer" ? IMPLEMENT_RESULT_START : REVIEW_RESULT_START
  const delimiterEnd = role === "implementer" ? IMPLEMENT_RESULT_END : REVIEW_RESULT_END

  const isValidOutput = (output: string) => {
    const startIdx = output.lastIndexOf(delimiterStart)
    if (startIdx === -1) return false
    const afterStart = startIdx + delimiterStart.length
    const endIdx = output.lastIndexOf(delimiterEnd)
    if (endIdx <= afterStart) return false
    return output.slice(afterStart, endIdx).trim().length > 0
  }

  return readFn(paneId, 280, isValidOutput)
}

export const mapTaskToReviewVerdict = (task: TaskFile, output: string): ReviewVerdict => {
  const parsed = parseReviewVerdict(extractReviewResult(output))
  const kind = task.status === "REVIEW_FAIL" ? "fail" as const
    : task.status === "REVIEW_NEEDS_CHECK" ? "needs_check" as const
    : "pass" as const

  return {
    cannotVerifySummary: parsed.cannotVerifySummary,
    hasCannotVerify: parsed.hasCannotVerify,
    kind,
    passed: kind === "pass",
  }
}

export const sendTaskWithTaskFile = async (
  paneId: string,
  prompt: string,
  tasksDir: string,
  runId: string,
  role: TaskRole,
) => {
  const { filePath: taskFilePath, runId: actualRunId } = await createTask(tasksDir, runId, role)
  const protocol = buildTaskProtocol(taskFilePath, actualRunId, role, orchestratorMain)
  const fullPrompt = prompt + "\n" + protocol

  await sendTask(paneId, fullPrompt)

  console.log(`[TaskStatus] Waiting for task ${actualRunId} to complete...`)
  const completedTask = await waitForTaskCompleted(taskFilePath)

  console.log(`[TaskStatus] Task ${actualRunId} completed (${completedTask.status}). Waiting 5s for output sync...`)
  const output = await waitForOutputAfterCompletion(paneId, role)

  return { output, task: completedTask }
}
