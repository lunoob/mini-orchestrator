const STRUCTURED_LOG_LINE_PATTERN = /^\[[^\]\r\n]+\]/
const DECORATED_LOG_LINE_PATTERN = /^\d{2}:\d{2}:\d{2} \[[^\]\r\n]+\]/
const LOG_DAY_LINE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

let lastLogDay: string | null = null

const pad2 = (value: number) => String(value).padStart(2, "0")

const formatLogDay = (date: Date) =>
  `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`

const formatLogTime = (date: Date) =>
  `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`

const isDecoratedLogLine = (line: string) => DECORATED_LOG_LINE_PATTERN.test(line)

export const isDecoratedLogMessage = (message: string) => {
  const lines = message.split("\n")
  const firstLine = lines[0] ?? ""
  if (LOG_DAY_LINE_PATTERN.test(firstLine)) {
    return isDecoratedLogLine(lines[1] ?? "")
  }
  return isDecoratedLogLine(firstLine)
}

export const resetLogDateState = () => {
  lastLogDay = null
}

const decorateStructuredLogLine = (line: string, date: Date) => {
  const day = formatLogDay(date)
  const segments: string[] = []
  if (lastLogDay !== null && lastLogDay !== day) segments.push(day)
  lastLogDay = day
  segments.push(`${formatLogTime(date)} ${line}`)
  return segments.join("\n")
}

export const decorateLogMessage = (message: string, date = new Date()) => {
  return message.split("\n").map((line) => (
    STRUCTURED_LOG_LINE_PATTERN.test(line)
      ? decorateStructuredLogLine(line, date)
      : line
  )).join("\n")
}

export const applyLogDecoration = (message: string, date = new Date()) =>
  isDecoratedLogMessage(message) ? message : decorateLogMessage(message, date)

// 使用稳定的 ANSI 256 色，保证同一前缀在不同日志位置保持同色。
const PREFIX_COLORS = [
  175, 186, 214, 110, 151, 179, 109, 182,
  176, 187, 215, 116, 152, 180, 150, 183,
] as const

const KNOWN_PREFIX_COLORS: Record<string, number> = {
  "[Agent]": 175,
  "[Workflow]": 186,
  "[Issue]": 214,
  "[Review]": 110,
  "[Gate]": 151,
  "[FinalGate]": 179,
  "[TestStatus]": 109,
  "[Skill]": 182,
  "[Install]": 176,
  "[CLI]": 187,
  "[Session]": 215,
  "[Implement]": 116,
  "[PostCheck]": 152,
  "[Revise]": 180,
  "[Baseline]": 150,
  "[EventBus]": 183,
}

const getPrefixColor = (prefix: string) => {
  if (KNOWN_PREFIX_COLORS[prefix] !== undefined) return KNOWN_PREFIX_COLORS[prefix]

  let hash = 0
  for (const char of prefix) {
    hash = (hash * 31 + char.codePointAt(0)!) >>> 0
  }
  return PREFIX_COLORS[hash % PREFIX_COLORS.length]
}

const colorizeLine = (line: string) => {
  if (LOG_DAY_LINE_PATTERN.test(line)) return line

  return line.replace(
    /^(\d{2}:\d{2}:\d{2} )?(\[[^\]\r\n]+\])/u,
    (_match, timePrefix: string | undefined, prefix: string) =>
      `${timePrefix ?? ""}\x1b[38;5;${getPrefixColor(prefix)}m${prefix}\x1b[0m`,
  )
}

export const colorizeLogMessage = (message: string) =>
  message.split("\n").map(colorizeLine).join("\n")
