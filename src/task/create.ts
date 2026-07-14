import { randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

import type { TaskFile, TaskRole } from "../types.js"
import { TASK_FILE_SUFFIX } from "./constants.js"

export type CreateTaskResult = {
  filePath: string
  runId: string
}

const tryWriteTaskFile = async (tasksDir: string, candidateRunId: string, role: TaskRole) => {
  const filePath = path.join(tasksDir, `${candidateRunId}${TASK_FILE_SUFFIX}`)
  const now = new Date().toISOString()
  const task: TaskFile = { runId: candidateRunId, role, state: "pending", createdAt: now, updatedAt: now }
  await writeFile(filePath, JSON.stringify(task, null, 2), { encoding: "utf8", flag: "wx" })
  return { filePath, runId: candidateRunId }
}

export const createTask = async (tasksDir: string, runId: string, role: TaskRole): Promise<CreateTaskResult> => {
  await mkdir(tasksDir, { recursive: true })

  try {
    return await tryWriteTaskFile(tasksDir, runId, role)
  } catch (err: unknown) {
    if (!(err instanceof Error) || (err as NodeJS.ErrnoException).code !== "EEXIST") throw err
    const fallbackRunId = `${runId}-${randomUUID()}`
    return tryWriteTaskFile(tasksDir, fallbackRunId, role)
  }
}
