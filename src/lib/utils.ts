import { extractStatus, parseStatus } from "./status-parser.js"
import type { AgentRole } from "../agent/transcript/types.js"

export const assertHerdrEnv = () => {
  if (process.env.HERDR_ENV === "1") return
  throw new Error("[Config] HERDR_ENV is not set to 1. Please run this inside a herdr pane.")
}

export const getErrorMessage = (error: unknown) => {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * 从 agent 输出中移除 STATUS 行，保留业务内容。
 * 作为 revise 流程传递 reviewer 反馈的文本。
 */
export const stripStatus = (output: string, role: AgentRole): string => {
  const { body } = parseStatus(output, role)
  return body
}

/** 打印 agent 输出的状态摘要 */
export const extractStatusSummary = (output: string, role: AgentRole): string => {
  const status = extractStatus(output, role)
  return status ?? "(no status)"
}


export const printSection = (title: string, body: string) => {
  console.log(`\n=== ${title} ===\n`)
  console.log(body.trim())
}

export const render = (template: string, values: Record<string, string>) =>
  template.replaceAll(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) =>
    key in values ? values[key] : match,
  )

export const splitCommand = (command: string) => {
  const parts: string[] = []
  let current = ""
  let quote: '"' | "'" | undefined

  for (const char of command) {
    if ((char === '"' || char === "'") && !quote) {
      quote = char
      continue
    }

    if (char === quote) {
      quote = undefined
      continue
    }

    if (char === " " && !quote) {
      if (current) parts.push(current)
      current = ""
      continue
    }

    current += char
  }

  if (current) parts.push(current)
  return parts
}
