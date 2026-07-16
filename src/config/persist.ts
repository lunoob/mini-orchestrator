import { readFile, writeFile } from "node:fs/promises"

import type { IssueConfig, IssueState } from "../types.js"

const markIssueState = async (
  configPath: string,
  issueIndex: number,
  state: IssueState,
  issues?: IssueConfig[],
) => {
  const content = await readFile(configPath, "utf8")
  const raw = JSON.parse(content) as { issues?: Array<Record<string, unknown>> }

  if (!Array.isArray(raw.issues) || !raw.issues[issueIndex]) {
    throw new Error(`[Config] Cannot mark ${state}: issues[${issueIndex}] not found in ${configPath}`)
  }

  raw.issues[issueIndex].state = state
  await writeFile(configPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8")

  if (issues?.[issueIndex]) {
    issues[issueIndex].state = state
  }

  console.log(`[Issue] Marked ${state} in config: issues[${issueIndex}] (${raw.issues[issueIndex].title ?? ""})`)
}

/** 将配置文件中指定 issue 标记为 review，并同步更新内存中的 issues（若传入） */
export const markIssueInReview = async (
  configPath: string,
  issueIndex: number,
  issues?: IssueConfig[],
) => markIssueState(configPath, issueIndex, "review", issues)

/** 将配置文件中指定 issue 标记为 finish，并同步更新内存中的 issues（若传入） */
export const markIssueFinished = async (
  configPath: string,
  issueIndex: number,
  issues?: IssueConfig[],
) => markIssueState(configPath, issueIndex, "finish", issues)
