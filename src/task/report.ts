import { rename, writeFile } from "node:fs/promises"
import path from "node:path"

import type { TaskFile, TaskState, TaskStatus } from "../types.js"
import {
  isValidStatusForRole,
  isValidTransition,
  TASK_FILE_SUFFIX,
  TASK_STATUSES_BY_ROLE,
  TMP_SUFFIX,
} from "./constants.js"
import { readTask } from "./read.js"

export const reportTask = async (
  filePath: string,
  state: TaskState,
  status?: TaskStatus,
): Promise<TaskFile> => {
  const expectedRunId = path.basename(filePath, TASK_FILE_SUFFIX)
  const current = await readTask(filePath, expectedRunId)

  if (!isValidTransition(current.state, state)) {
    throw new Error(
      `[TaskStatus] Invalid transition: ${current.state} → ${state} for task ${current.runId}`,
    )
  }

  if (state === "completed") {
    if (!status) {
      throw new Error("[TaskStatus] Status is required for completed state")
    }
    if (!isValidStatusForRole(current.role, status)) {
      throw new Error(
        `[TaskStatus] Invalid status "${status}" for role "${current.role}". ` +
        `Allowed: ${TASK_STATUSES_BY_ROLE[current.role].join(", ")}`,
      )
    }
  }

  const now = new Date().toISOString()
  const updated: TaskFile = { ...current, state, updatedAt: now }
  if (status !== undefined) updated.status = status

  const tmpPath = filePath + TMP_SUFFIX
  await writeFile(tmpPath, JSON.stringify(updated, null, 2), "utf8")
  await rename(tmpPath, filePath)

  return updated
}
