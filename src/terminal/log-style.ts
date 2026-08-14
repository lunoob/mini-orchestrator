const LOG_PREFIX_PATTERN = /^(\[[^\]\r\n]+\])/u

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

const colorizeLine = (line: string) => line.replace(
  LOG_PREFIX_PATTERN,
  (prefix) => `\x1b[38;5;${getPrefixColor(prefix)}m${prefix}\x1b[0m`,
)

export const colorizeLogMessage = (message: string) =>
  message.split("\n").map(colorizeLine).join("\n")
