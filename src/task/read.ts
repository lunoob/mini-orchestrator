import { readFile } from "node:fs/promises"
import path from "node:path"

import type { TaskFile } from "../types.js"
import {
  isValidTaskRole,
  isValidTaskState,
  isValidStatusForRole,
  TASK_FILE_SUFFIX,
} from "./constants.js"

export const validateTaskFile = (parsed: Record<string, unknown>): TaskFile => {
  const fieldError = (field: string, detail = "") =>
    `[TaskStatus] Invalid task file: ${detail ? `${detail} — ` : ""}required field "${field}"`

  if (typeof parsed.runId !== "string" || !parsed.runId) {
    throw new Error(fieldError("runId"))
  }
  if (typeof parsed.role !== "string" || !isValidTaskRole(parsed.role)) {
    throw new Error(`[TaskStatus] Invalid task file: invalid or missing "role": ${parsed.role}`)
  }
  if (typeof parsed.state !== "string" || !isValidTaskState(parsed.state)) {
    throw new Error(`[TaskStatus] Invalid task file: invalid or missing "state": ${parsed.state}`)
  }
  if (typeof parsed.createdAt !== "string" || !parsed.createdAt) {
    throw new Error(fieldError("createdAt"))
  }
  if (typeof parsed.updatedAt !== "string" || !parsed.updatedAt) {
    throw new Error(fieldError("updatedAt"))
  }

  const task = parsed as TaskFile

  if (task.state === "completed") {
    if (!task.status || !isValidStatusForRole(task.role, task.status)) {
      throw new Error(
        `[TaskStatus] Invalid task file: completed state requires valid status for role "${task.role}"`,
      )
    }
  }

  return task
}

export const readTask = async (filePath: string, expectedRunId?: string): Promise<TaskFile> => {
  const content = await readFile(filePath, "utf8")
  const parsed = JSON.parse(content) as Record<string, unknown>
  const task = validateTaskFile(parsed)

  if (expectedRunId !== undefined && task.runId !== expectedRunId) {
    throw new Error(
      `[TaskStatus] RunId mismatch: file "${path.basename(filePath)}" ` +
      `contains runId "${task.runId}", expected "${expectedRunId}"`,
    )
  }

  return task
}
