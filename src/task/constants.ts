import type { TaskRole, TaskState, TaskStatus } from "../types.js"

export const TASK_STATUSES_BY_ROLE: Record<TaskRole, readonly TaskStatus[]> = {
  implementer: ["IMPLEMENT_DONE", "IMPLEMENT_ASK"],
  reviewer: ["REVIEW_PASS", "REVIEW_FAIL", "REVIEW_NEEDS_CHECK"],
}

export const VALID_TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  pending: ["started"],
  started: ["completed"],
  completed: [],
}

export const VALID_STATES: readonly TaskState[] = ["pending", "started", "completed"]

export const VALID_ROLES: readonly TaskRole[] = ["implementer", "reviewer"]

export const TASK_FILE_SUFFIX = ".json"
export const TMP_SUFFIX = ".tmp"

export const isValidTaskRole = (value: string): value is TaskRole =>
  (VALID_ROLES as readonly string[]).includes(value)

export const isValidTaskState = (value: string): value is TaskState =>
  (VALID_STATES as readonly string[]).includes(value)

export const isValidStatusForRole = (role: TaskRole, status: string): status is TaskStatus =>
  (TASK_STATUSES_BY_ROLE[role] as readonly string[]).includes(status)

export const isValidTransition = (from: TaskState, to: TaskState): boolean =>
  (VALID_TRANSITIONS[from] as readonly string[]).includes(to)
