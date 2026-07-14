import type { TaskState, TaskStatus } from "../types.js"
import { VALID_STATES } from "./constants.js"
import { readTask } from "./read.js"
import { reportTask } from "./report.js"

const isTaskState = (value: string): value is TaskState =>
  (VALID_STATES as readonly string[]).includes(value)

export const handleReportTaskCli = async (argv: string[]) => {
  const args: Record<string, string> = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith("--")) continue

    const key = arg.slice(2)
    const value = argv[index + 1]
    if (!value || value.startsWith("--")) {
      args[key] = "true"
      continue
    }

    args[key] = value
    index += 1
  }

  const taskFilePath = args.task
  if (!taskFilePath) throw new Error("[TaskStatus] Missing required argument --task")

  const stateRaw = args.state
  if (!stateRaw) throw new Error("[TaskStatus] Missing required argument --state")
  if (!isTaskState(stateRaw)) {
    throw new Error(`[TaskStatus] Invalid state "${stateRaw}". Must be one of: ${VALID_STATES.join(", ")}`)
  }

  const statusRaw = args.status
  if (stateRaw === "completed" && !statusRaw) {
    throw new Error("[TaskStatus] Missing required argument --status (required when --state completed)")
  }

  const previous = await readTask(taskFilePath)
  const updated = await reportTask(taskFilePath, stateRaw, statusRaw as TaskStatus | undefined)

  console.log(
    `[TaskStatus] Task ${updated.runId}: ${previous.state} → ${updated.state}` +
    (updated.status ? ` (${updated.status})` : ""),
  )
}
