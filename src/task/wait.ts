import { watch } from "node:fs"
import path from "node:path"

import type { TaskFile } from "../types.js"
import { TASK_FILE_SUFFIX } from "./constants.js"
import { readTask } from "./read.js"

const DEFAULT_POLL_INTERVAL_MS = 1000
const DEFAULT_TIMEOUT_MS = 1_800_000

export type WaitOptions = {
  pollIntervalMs?: number
  timeoutMs?: number
}

export const waitForTaskCompleted = async (
  filePath: string,
  options: WaitOptions = {},
): Promise<TaskFile> => {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const deadline = Date.now() + timeoutMs
  const tasksDir = path.dirname(filePath)
  const expectedFileName = path.basename(filePath)
  const expectedRunId = path.basename(filePath, TASK_FILE_SUFFIX)

  const tryRead = async (): Promise<TaskFile | null> => {
    try {
      const task = await readTask(filePath)
      if (task.runId !== expectedRunId) return null
      if (task.state === "completed" && task.status) return task
      return null
    } catch (_e) {
      return null
    }
  }

  const immediate = await tryRead()
  if (immediate) return immediate

  return new Promise<TaskFile>((resolve, reject) => {
    let resolved = false
    let watcher: ReturnType<typeof watch> | null = null
    let interval: ReturnType<typeof setInterval> | null = null

    const cleanup = () => {
      resolved = true
      if (watcher) { watcher.close(); watcher = null }
      if (interval) { clearInterval(interval); interval = null }
    }

    const onFound = (task: TaskFile) => {
      if (resolved) return
      cleanup()
      resolve(task)
    }

    interval = setInterval(async () => {
      if (resolved) return

      if (Date.now() > deadline) {
        cleanup()
        try {
          const current = await readTask(filePath)
          reject(new Error(
            `[TaskStatus] Task ${expectedRunId} did not complete within timeout. ` +
            `Current state: ${current.state}, status: ${current.status ?? "N/A"}, path: ${filePath}`,
          ))
        } catch (_e) {
          reject(new Error(
            `[TaskStatus] Task ${expectedRunId} did not complete within timeout. ` +
            `File not found at ${filePath}`,
          ))
        }
        return
      }

      const task = await tryRead()
      if (task) onFound(task)
    }, pollIntervalMs)

    try {
      watcher = watch(tasksDir, async (_eventType, filename) => {
        if (resolved) return
        if (filename !== expectedFileName) return
        const task = await tryRead()
        if (task) onFound(task)
      })
    } catch (_e) {
      // watch 失败时靠轮询兜底
    }
  })
}
