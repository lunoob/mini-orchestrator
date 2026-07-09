import { spawnSync } from "node:child_process"

type NotifyLevel = "success" | "warning" | "error"

const SUBTITLES: Record<NotifyLevel, string> = {
  success: "✅ 工作流完成",
  warning: "⚠️ 需要人工 Review",
  error: "❌ 错误",
}

/**
 * 使用 macOS terminal-notifier 发送桌面通知。
 * terminal-notifier 不可用时静默失败，不阻塞主流程。
 */
const notify = (title: string, message: string, level: NotifyLevel) => {
  try {
    const result = spawnSync("terminal-notifier", [
      "-title", title,
      "-subtitle", SUBTITLES[level],
      "-message", message,
    ], { timeout: 5000 })

    if (result.error) {
      // terminal-notifier 不可用，静默忽略
    }
  } catch {
    // 静默失败
  }
}

/** 编排器正常完成 */
export const notifySuccess = () => {
  notify(
    "编排器",
    "所有 issue 已处理完毕，请查看结果。",
    "success",
  )
}

/** needs_check 暂停，等待人工介入 */
export const notifyNeedsCheck = (checkpointPath: string) => {
  notify(
    "编排器",
    `Reviewer 无法完全验证，请在主对话中处理。\nCHECKPOINT: ${checkpointPath}`,
    "warning",
  )
}

/** 编排器出错 */
export const notifyError = (errorMessage: string) => {
  // terminal-notifier 的 -message 长度有限，截取前 200 字符
  const shortMsg = errorMessage.length > 200
    ? `${errorMessage.slice(0, 197)}...`
    : errorMessage

  notify(
    "编排器",
    shortMsg,
    "error",
  )
}
