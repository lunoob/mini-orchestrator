/**
 * Agent activity event — represents a tool or notice event in the activity stream.
 * Used by adapters to emit structured activity that the renderer displays in the right pane.
 */
export type AgentActivity = {
  /** Activity kind */
  kind: "tool_started" | "tool_completed" | "tool_failed" | "notice"
  /** Short human-readable label for the activity */
  label: string
  /** Optional sanitized detail (must go through sanitizeDetail before storage) */
  detail?: string
  /** Associated turn ID */
  turnId: string
}

const CONTROL_CHAR_RE = /[\x00-\x1F\x7F]/g

const DEFAULT_MAX_LABEL_LENGTH = 120
const DEFAULT_MAX_DETAIL_LENGTH = 200

/**
 * Sanitize a string for safe display:
 * - Strip all control characters (including newlines and tabs)
 * - Truncate to maxLen with ellipsis
 */
const sanitizeString = (input: string, maxLen: number): string => {
  const cleaned = input.replace(CONTROL_CHAR_RE, "")
  if (cleaned.length <= maxLen) return cleaned
  return `${cleaned.slice(0, maxLen - 3)}...`
}

/**
 * Sanitize a label string for safe display.
 */
export const sanitizeLabel = (input: string, maxLen = DEFAULT_MAX_LABEL_LENGTH): string =>
  sanitizeString(input, maxLen)

/**
 * Sanitize a detail string for safe display.
 */
export const sanitizeDetail = (input: string | undefined, maxLen = DEFAULT_MAX_DETAIL_LENGTH): string | undefined => {
  if (input === undefined) return undefined
  return sanitizeString(input, maxLen)
}

/**
 * Create a sanitized AgentActivity. Use this in adapters to ensure
 * all activity data is clean before entering any event channel.
 */
export const createActivity = (
  kind: AgentActivity["kind"],
  label: string,
  turnId: string,
  detail?: string,
): AgentActivity => ({
  detail: sanitizeDetail(detail),
  kind,
  label: sanitizeLabel(label),
  turnId,
})

const KIND_PREFIX: Record<AgentActivity["kind"], string> = {
  notice: "[Notice]",
  tool_completed: "[Tool ✓]",
  tool_failed: "[Tool ✗]",
  tool_started: "[Tool]",
}

/**
 * Format an AgentActivity as a single display line.
 * Pure function — no I/O side effects.
 */
export const formatActivity = (activity: AgentActivity): string => {
  const prefix = KIND_PREFIX[activity.kind]
  const detailSuffix = activity.detail !== undefined ? ` — ${activity.detail}` : ""
  return `${prefix} ${activity.label}${detailSuffix}`
}
