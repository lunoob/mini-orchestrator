import { spawnSync } from "node:child_process"

type NotifyLevel = "success" | "warning" | "error"
type NotificationCommand = {
  args: string[]
  command: string
}

const SUBTITLES: Record<NotifyLevel, string> = {
  success: "✅ 工作流完成",
  warning: "⚠️ 需要人工 Review",
  error: "❌ 错误",
}

const escapeAppleScriptString = (value: string) => {
  const escaped = value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\r", "\\r")
    .replaceAll("\n", "\\n")

  return `"${escaped}"`
}

export const buildNotificationCommand = (
  platform: NodeJS.Platform,
  title: string,
  message: string,
  level: NotifyLevel,
): NotificationCommand | undefined => {
  if (platform !== "darwin") return

  // osascript is built into macOS, so npm users do not need another notifier binary.
  const script = [
    `display notification ${escapeAppleScriptString(message)}`,
    `with title ${escapeAppleScriptString(title)}`,
    `subtitle ${escapeAppleScriptString(SUBTITLES[level])}`,
  ].join(" ")

  return {
    args: ["-e", script],
    command: "osascript",
  }
}

const notify = (title: string, message: string, level: NotifyLevel) => {
  const command = buildNotificationCommand(process.platform, title, message, level)
  if (!command) return

  try {
    const result = spawnSync(command.command, command.args, { timeout: 5000 })

    if (result.error) {
      // 系统通知不可用时不影响主工作流。
    }
  } catch {
    // 静默失败
  }
}

export const notifySuccess = () => {
  notify(
    "编排器",
    "所有 issue 已处理完毕，请查看结果。",
    "success",
  )
}

export const notifyIssueComplete = (title: string) => {
  notify(
    "编排器",
    `Issue 已完成：${title}`,
    "success",
  )
}

export const notifyTestStatusComplete = () => {
  notify(
    "编排器",
    "herdr 状态测试完成，请查看 agent 输出。",
    "success",
  )
}

export const notifyImplementAsk = () => {
  notify(
    "编排器",
    "Implementer 有问题需要确认。",
    "warning",
  )
}

export const notifyError = (errorMessage: string) => {
  const shortMsg = errorMessage.length > 200
    ? `${errorMessage.slice(0, 197)}...`
    : errorMessage

  notify(
    "编排器",
    shortMsg,
    "error",
  )
}

// ── needs_input / invalid_output 通知 + 去重 ──

/** 通知去重器：按 key 确保同一 agent 同一 turn 只通知一次 */
export type NotifyDedup = {
  notifyOnce: (key: string, fn: () => void) => void
}

export const createNotifyDedup = (): NotifyDedup => {
  const keys = new Set<string>()
  return {
    notifyOnce: (key, fn) => {
      if (keys.has(key)) return
      keys.add(key)
      fn()
    },
  }
}

let globalDedupKeys = new Set<string>()

export const resetNotifyDedup = () => {
  globalDedupKeys = new Set()
}

// 全局去重器也使用独立 set
const globalDedup: NotifyDedup = {
  notifyOnce: (key, fn) => {
    if (globalDedupKeys.has(key)) return
    globalDedupKeys.add(key)
    fn()
  },
}

export const notifyNeedsInput = (
  role: string,
  provider: string,
  reason: string,
  resumeId?: string,
  paneId?: string,
  /** turn 序号或偏移，确保同一 turn 只通知一次 */
  turnId?: string,
) => {
  const key = `needs_input:${role}:${provider}:${resumeId ?? "unknown"}:${turnId ?? "0"}`
  globalDedup.notifyOnce(key, () => {
    const paneInfo = paneId ? ` (pane: ${paneId})` : ""
    notify(
      "编排器",
      `[${role}/${provider}]${paneInfo} 需要人工输入: ${reason}`,
      "warning",
    )
  })
}

export const notifyInvalidOutput = (
  role: string,
  provider: string,
  reason: string,
  resumeId?: string,
  paneId?: string,
  turnId?: string,
) => {
  const key = `invalid_output:${role}:${provider}:${resumeId ?? "unknown"}:${turnId ?? "0"}`
  globalDedup.notifyOnce(key, () => {
    const paneInfo = paneId ? ` (pane: ${paneId})` : ""
    notify(
      "编排器",
      `[${role}/${provider}]${paneInfo} 输出无效: ${reason}`,
      "error",
    )
  })
}
