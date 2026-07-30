/** 统一 Agent 状态 */
export type AgentStatus = "working" | "completed" | "failed" | "needs_input" | "invalid_output"

/** JSONL 事件：adapter 处理每一行 JSONL 后产出的事件 */
export type TranscriptEvent = {
  /** 事件类型 */
  type: AgentStatus
  /** 事件相关的文本内容（若有） */
  text?: string
  /** needs_input 时的提问详情 */
  question?: string
  /** invalid_output 时的原因描述 */
  reason?: string
}

/** Bootstrap 返回的会话句柄，由 headless 命令的 stdout JSON 解析得到 */
export type AgentSessionHandle = {
  /** Agent provider 标识 */
  provider: "claude" | "codex" | "cursor"
  /** 用于恢复会话的 ID */
  resumeId: string
  /** JSONL 文件路径 */
  jsonl: string
  /** 上次读取的字符偏移，避免重放历史事件 */
  offset: number
}

/** Agent 角色 */
export type AgentRole = "implementer" | "reviewer"

/** 合法 implementer STATUS 值 */
export const IMPLEMENT_STATUSES = ["IMPLEMENT_DONE", "IMPLEMENT_ASK"] as const
export type ImplementStatusValue = (typeof IMPLEMENT_STATUSES)[number]

/** 合法 reviewer STATUS 值 */
export const REVIEW_STATUSES = ["REVIEW_PASS", "REVIEW_FAIL", "REVIEW_NEEDS_CHECK"] as const
export type ReviewStatusValue = (typeof REVIEW_STATUSES)[number]

/** 所有合法 STATUS 值 */
export const ALL_LEGAL_STATUSES = [...IMPLEMENT_STATUSES, ...REVIEW_STATUSES] as const

/** STATUS 解析结果 */
export type StatusParseResult =
  | { status: "completed"; statusValue: string; output: string }
  | { status: "needs_input"; statusValue: string; output: string }
  | { status: "invalid_output"; reason: string; output: string }

/** Transcript monitor 的监听器回调 */
export type TranscriptListener = (event: TranscriptEvent) => void

/** 暂停/恢复上下文，用于 terminal 模式暂停和 LLM 模式 checkpoint */
export type PauseContext = {
  role: AgentRole
  provider: string
  resumeId: string
  jsonl: string
  paneId?: string
  reason: string
  question?: string
  /** 当前任务/轮次描述 */
  taskDescription: string
}
