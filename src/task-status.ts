import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { watch } from "node:fs"
import path from "node:path"

import type { TaskFile, TaskRole, TaskState, TaskStatus } from "./types.js"

/** 每个角色允许回报的 status 集合 */
export const TASK_STATUSES_BY_ROLE: Record<TaskRole, readonly TaskStatus[]> = {
  implementer: ["IMPLEMENT_DONE", "IMPLEMENT_ASK"],
  reviewer: ["REVIEW_PASS", "REVIEW_FAIL", "REVIEW_NEEDS_CHECK"],
}

/** 合法的状态转换映射 */
const VALID_TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  pending: ["started"],
  started: ["completed"],
  completed: [],
}

const TASK_FILE_SUFFIX = ".json"
const TMP_SUFFIX = ".tmp"

const DEFAULT_POLL_INTERVAL_MS = 1000
const DEFAULT_TIMEOUT_MS = 1_800_000 // 30 分钟，与 herdr idle 超时一致

export type WaitOptions = {
  pollIntervalMs?: number
  timeoutMs?: number
}

/** createTask 返回值，包含实际使用的 filePath 与 runId（碰撞时可能与传入不同） */
export type CreateTaskResult = {
  filePath: string
  /** 实际写入文件的 runId——碰撞重试时可能与传入 runId 不同 */
  runId: string
}

const tryWriteTaskFile = async (tasksDir: string, candidateRunId: string, role: TaskRole) => {
  const filePath = path.join(tasksDir, `${candidateRunId}${TASK_FILE_SUFFIX}`)
  const now = new Date().toISOString()
  const task: TaskFile = { runId: candidateRunId, role, state: "pending", createdAt: now, updatedAt: now }
  // wx flag: 排他写入，文件已存在时抛 EEXIST
  await writeFile(filePath, JSON.stringify(task, null, 2), { encoding: "utf8", flag: "wx" })
  return { filePath, runId: candidateRunId }
}

/**
 * 创建任务文件，写入 pending 状态。
 * 使用排他写入（wx flag），目标文件存在时自动生成 UUID 后缀重试，
 * 确保 resume 场景下不会覆盖旧任务文件。
 */
export const createTask = async (tasksDir: string, runId: string, role: TaskRole): Promise<CreateTaskResult> => {
  await mkdir(tasksDir, { recursive: true })

  try {
    return await tryWriteTaskFile(tasksDir, runId, role)
  } catch (err: unknown) {
    // 仅 EEXIST 碰撞时重试；其他错误直接抛
    if (!(err instanceof Error) || (err as NodeJS.ErrnoException).code !== "EEXIST") throw err
    const fallbackRunId = `${runId}-${randomUUID()}`
    return tryWriteTaskFile(tasksDir, fallbackRunId, role)
  }
}

const VALID_ROLES: readonly TaskRole[] = ["implementer", "reviewer"]

export const isValidTaskRole = (value: string): value is TaskRole =>
  (VALID_ROLES as readonly string[]).includes(value)

export const isValidTaskState = (value: string): value is TaskState =>
  (VALID_STATES as readonly string[]).includes(value)

const isValidStatusForRole = (role: TaskRole, status: string): status is TaskStatus =>
  (TASK_STATUSES_BY_ROLE[role] as readonly string[]).includes(status)

/**
 * 对已解析的任务文件 JSON 做完整协议校验。
 * 校验所有必要字段、枚举值、以及 completed 状态下 status 与 role 的匹配。
 */
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

  // completed 状态必须带有效 status，且 status 必须匹配角色
  if (task.state === "completed") {
    if (!task.status || !isValidStatusForRole(task.role, task.status)) {
      throw new Error(
        `[TaskStatus] Invalid task file: completed state requires valid status for role "${task.role}"`,
      )
    }
  }

  return task
}

/**
 * 读取并校验任务文件。
 * 文件缺失、JSON 损坏或协议字段不完整时抛出。
 * @param expectedRunId — 若提供，校验文件内 runId 与预期值（通常为文件名去后缀）一致
 */
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

const isValidTransition = (from: TaskState, to: TaskState): boolean =>
  (VALID_TRANSITIONS[from] as readonly string[]).includes(to)

/**
 * 原子更新任务状态。
 * 校验状态转换合法性、角色与 status 匹配，通过临时文件 + rename 保证原子写入。
 */
export const reportTask = async (
  filePath: string,
  state: TaskState,
  status?: TaskStatus,
): Promise<TaskFile> => {
  // 从文件路径推导预期 runId，防止文件内容与文件名不匹配
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

  // 临时文件 + rename 实现原子写入
  const tmpPath = filePath + TMP_SUFFIX
  await writeFile(tmpPath, JSON.stringify(updated, null, 2), "utf8")
  await rename(tmpPath, filePath)

  return updated
}

/**
 * 等待任务文件完成（state === "completed" 且带 status）。
 * 使用 fs.watch 监听目录变更，同时以 pollIntervalMs 间隔定时读取兜底。
 * 超时时抛出包含当前状态和文件路径的错误。
 */
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

  // 检查文件的辅助函数
  const tryRead = async (): Promise<TaskFile | null> => {
    try {
      const task = await readTask(filePath)
      if (task.runId !== expectedRunId) return null
      if (task.state === "completed" && task.status) return task
      return null
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (_e) {
      return null
    }
  }

  // 先立即检查一次
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

    // 定时轮询兜底
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
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
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

    // fs.watch 监听目录（更快响应）
    try {
      watcher = watch(tasksDir, async (_eventType, filename) => {
        if (resolved) return
        if (filename !== expectedFileName) return
        const task = await tryRead()
        if (task) onFound(task)
      })
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (_e) {
      // watch 失败时靠轮询兜底
    }
  })
}

/**
 * 为 agent 构建任务状态回报协议文本，追加到 prompt 末尾。
 * taskFilePath 和 runId 必须与 createTask 返回的一致。
 */
export const buildTaskProtocol = (
  taskFilePath: string,
  runId: string,
  role: TaskRole,
  orchestratorMain: string,
) => {
  const statuses = TASK_STATUSES_BY_ROLE[role]

  return `
## 任务状态回报协议（编排器读取）

你必须通过 CLI 命令回报任务状态。编排器以此推进流程，不依赖 agent 面板状态。

- **任务文件**: \`${taskFilePath}\`
- **runId**: \`${runId}\`
- **角色**: ${role}

### 严格操作顺序

1. **开始工作前**，先执行：
   \`\`\`bash
   npx tsx "${orchestratorMain}" report-task --task "${taskFilePath}" --state started
   \`\`\`

2. **完成全部工作后**，按此顺序：
   a. 先输出完整最终结果（含 \`STATUS:\` 标记和结果分隔符）
   b. 再执行：
   \`\`\`bash
   npx tsx "${orchestratorMain}" report-task --task "${taskFilePath}" --state completed --status <你的状态>
   \`\`\`

   你的可用 status：
${statuses.map(s => `   - \`${s}\``).join("\n")}

⚠️ **关键**：必须在输出完整结果之后再回报 completed。回报后编排器会立即读取终端输出。
`
}

const VALID_STATES: readonly TaskState[] = ["pending", "started", "completed"]

const isTaskState = (value: string): value is TaskState =>
  (VALID_STATES as readonly string[]).includes(value)

/**
 * 处理 report-task CLI 子命令。
 * 从内部 agent 接收状态回报，校验参数并调用 reportTask。
 * 不解析 --config 等 workflow 参数——仅处理 report-task 子命令。
 */
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
