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
    "Agent 状态测试完成，请查看 agent 输出。",
    "success",
  )
}

export const notifyNeedsCheck = (checkpointPath: string) => {
  notify(
    "编排器",
    `Reviewer 无法完全验证，请在主对话中处理。\nCHECKPOINT: ${checkpointPath}`,
    "warning",
  )
}

export const notifyImplementAsk = () => {
  notify(
    "编排器",
    "Implementer 有问题需要确认。",
    "warning",
  )
}

export const notifyNeedsInput = (question: string) => {
  const shortQuestion = question.length > 100
    ? `${question.slice(0, 97)}...`
    : question
  notify(
    "编排器",
    `需要用户输入: ${shortQuestion}`,
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
