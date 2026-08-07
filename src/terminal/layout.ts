/**
 * 状态面板布局计算模块。
 *
 * 根据终端宽度将状态字段紧凑排列，宽度不足时自动换行。
 * 不依赖 Blessed，只做纯计算。
 */

import type { WorkflowSnapshot, InteractionRequest } from "../workflow/events.js"
import { LOG_STATUS_GAP } from "./layout-constants.js"

export type LayoutResult = {
  /** 状态面板内容行 */
  lines: string[]
  /** 状态面板高度（行数） */
  panelHeight: number
  /** 日志区高度 */
  logHeight: number
}

/**
 * 计算字符串在终端中的显示宽度。
 *
 * - CJK 字符占 2 个 cell
 * - ANSI 转义序列占 0 个 cell
 * - 普通 ASCII 占 1 个 cell
 */
export const getStringDisplayWidth = (str: string): number => {
  // 移除 ANSI 转义序列
  // eslint-disable-next-line no-control-regex
  const stripped = str.replace(/\x1b\[[0-9;]*m/g, "")
  let width = 0
  for (const char of stripped) {
    const code = char.codePointAt(0)!
    // CJK 统一表意文字、兼容表意文字、扩展 A/B
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0x20000 && code <= 0x2a6df) ||
      (code >= 0x2a700 && code <= 0x2b73f) ||
      (code >= 0x2b740 && code <= 0x2b81f) ||
      (code >= 0x2b820 && code <= 0x2ceaf) ||
      (code >= 0x2ceb0 && code <= 0x2ebef) ||
      (code >= 0x30000 && code <= 0x3134f)
    ) {
      width += 2
    }
    // 全角标点、全角 ASCII、片假名
    else if (
      (code >= 0xff01 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x3000 && code <= 0x303f) ||
      (code >= 0x3040 && code <= 0x309f) ||
      (code >= 0x30a0 && code <= 0x30ff)
    ) {
      width += 2
    }
    // Emoji (surrogate pairs handled by codePointAt)
    else if (
      (code >= 0x1f300 && code <= 0x1f9ff) ||
      (code >= 0x2600 && code <= 0x26ff) ||
      (code >= 0x2700 && code <= 0x27bf)
    ) {
      width += 2
    }
    // 组合字符（零宽）
    else if (code >= 0x0300 && code <= 0x036f) {
      width += 0
    }
    else {
      width += 1
    }
  }
  return width
}

/** 将毫秒格式化为 HH:MM:SS */
export const formatElapsed = (ms: number): string => {
  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  return `Duration: ${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
}

/** 格式化状态行内容 */
export const formatStatusLine = (snap: WorkflowSnapshot, _cols: number): string => {
  const parts: string[] = []

  if (snap.workflowTitle) {
    parts.push(snap.workflowTitle)
  }

  // Issue progress
  parts.push(`Issue: ${snap.issueIndex + 1}/${snap.issueCount}`)

  // Issue title
  if (snap.issueTitle) {
    parts.push(snap.issueTitle)
  }

  // Phase
  parts.push(snap.phase)

  // Review round (if not idle)
  if (snap.reviewRound > 0) {
    parts.push(`R${snap.reviewRound}/${snap.maxReviewRounds}`)
  }

  // Agent statuses
  parts.push(`IMP:${snap.implementerStatus}`)
  parts.push(`REV:${snap.reviewerStatus}`)

  // Elapsed time
  parts.push(formatElapsed(snap.elapsedMs))

  // Terminal state
  if (snap.terminalState) {
    parts.push(snap.terminalState)
  }

  // Needs input details
  if (snap.needsInput) {
    const reasonLines = snap.needsInput.reason.split("\n")
    for (const line of reasonLines) {
      parts.push(`${snap.needsInput.agent}(${snap.needsInput.provider}): ${line}`)
    }
  }

  return parts.join(" | ")
}

/**
 * 找到字符串中不超过 maxDisplayWidth 的断行位置。
 * 返回字符索引（可用于 slice）。
 */
const findBreakPoint = (text: string, maxDisplayWidth: number): number => {
  let width = 0
  let lastSpaceIdx = -1
  let lastSpaceWidth = 0

  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    const code = char.codePointAt(0)!

    // 检查空格断行点
    if (char === " ") {
      lastSpaceIdx = i
      lastSpaceWidth = width
    }

    // 计算当前字符宽度
    let charWidth = 1
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0x20000 && code <= 0x2a6df) ||
      (code >= 0x3000 && code <= 0x303f) ||
      (code >= 0x3040 && code <= 0x309f) ||
      (code >= 0x30a0 && code <= 0x30ff) ||
      (code >= 0xff01 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      ((code >= 0x1f300 && code <= 0x1f9ff) || (code >= 0x2600 && code <= 0x26ff) || (code >= 0x2700 && code <= 0x27bf))
    ) {
      charWidth = 2
    } else if (code >= 0x0300 && code <= 0x036f) {
      charWidth = 0
    }

    if (width + charWidth > maxDisplayWidth) {
      // 超出宽度，使用最近的空格断行点
      if (lastSpaceIdx > 0) {
        return lastSpaceIdx
      }
      // 没有空格，强制在当前位置断行（至少保证 1 个字符）
      return Math.max(1, i)
    }

    width += charWidth
    // 跳过 surrogate pair 的高代理
    if (code > 0xffff) {
      i++
    }
  }

  return text.length
}

/** 将长文本按显示宽度限制拆分为多行 */
const wrapText = (text: string, maxWidth: number): string[] => {
  if (getStringDisplayWidth(text) <= maxWidth) {
    return [text]
  }

  const lines: string[] = []
  let remaining = text

  while (remaining.length > 0 && getStringDisplayWidth(remaining) > maxWidth) {
    const breakPoint = findBreakPoint(remaining, maxWidth)
    lines.push(remaining.slice(0, breakPoint))
    remaining = remaining.slice(breakPoint).trimStart()
  }

  if (remaining.length > 0) {
    lines.push(remaining)
  }

  return lines
}

/** 格式化交互请求（prompt + 按钮选项） */
export const formatInteractionRequest = (req: InteractionRequest): string[] => {
  const lines: string[] = []

  for (const line of req.prompt.split("\n")) {
    lines.push(line)
  }

  if (req.actions && req.actions.length > 0) {
    const actionParts = req.actions.map((a, i) => `[${i + 1}]${a}`)
    lines.push(actionParts.join(" "))
  }

  return lines
}

/** 将一行文本按宽度限制拆分为多行 */
const wrapLine = (text: string, cols: number): string[] => {
  if (getStringDisplayWidth(text) <= cols) {
    return [text]
  }

  const segments = text.split(" | ")
  const lines: string[] = []
  let currentLine = ""
  let currentWidth = 0

  for (const seg of segments) {
    const segWidth = getStringDisplayWidth(seg)

    if (currentLine.length === 0) {
      if (segWidth > cols) {
        const wrapped = wrapText(seg, cols)
        lines.push(...wrapped.slice(0, -1))
        currentLine = wrapped[wrapped.length - 1]
        currentWidth = getStringDisplayWidth(currentLine)
      } else {
        currentLine = seg
        currentWidth = segWidth
      }
    } else if (currentWidth + 3 + segWidth <= cols) {
      currentLine += " | " + seg
      currentWidth += 3 + segWidth
    } else {
      lines.push(currentLine)
      if (segWidth > cols) {
        const wrapped = wrapText(seg, cols)
        lines.push(...wrapped.slice(0, -1))
        currentLine = wrapped[wrapped.length - 1]
        currentWidth = getStringDisplayWidth(currentLine)
      } else {
        currentLine = seg
        currentWidth = segWidth
      }
    }
  }

  if (currentLine.length > 0) {
    lines.push(currentLine)
  }

  return lines
}

/** 计算布局 */
export const calculateLayout = (
  snap: WorkflowSnapshot,
  cols: number,
  rows: number,
  interactionRequest?: InteractionRequest | null,
): LayoutResult => {
  const statusLine = formatStatusLine(snap, cols)
  const interactionLines = interactionRequest ? formatInteractionRequest(interactionRequest) : []

  // 状态行换行
  const statusLines = wrapLine(statusLine, cols)

  // 交互请求行换行
  const wrappedInteractionLines: string[] = []
  for (const line of interactionLines) {
    wrappedInteractionLines.push(...wrapLine(line, cols))
  }

  const lines = [...statusLines, ...wrappedInteractionLines]

  // 确保至少有一行
  if (lines.length === 0) {
    lines.push("")
  }

  const panelHeight = lines.length
  const logHeight = Math.max(0, rows - panelHeight - LOG_STATUS_GAP)

  return {
    lines,
    panelHeight,
    logHeight,
  }
}
