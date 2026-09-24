import { readFile, writeFile } from "node:fs/promises"

import type { IssueConfig, IssueState, WorkflowConfig, WorkflowStatus } from "../types.js"

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

/** 回写 workflow 顶层 status，并同步更新内存中的 config（若传入） */
export const setWorkflowStatus = async (
  configPath: string,
  status: WorkflowStatus,
  config?: WorkflowConfig,
) => {
  const content = await readFile(configPath, "utf8")
  const raw = JSON.parse(content) as Record<string, unknown>

  raw.status = status
  await writeFile(configPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8")

  if (config) {
    config.status = status
  }

  console.log(`[Config] Workflow status → ${status}`)
}
