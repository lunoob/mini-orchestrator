import path from "node:path"

import { loadConfig, loadPrompts } from "../config/load.js"
import { getReviewBaselineSha, isGitRepo } from "../git/index.js"
import type { ParsedArgs } from "../types.js"
import { createWorkflowEventBus, type WorkflowEventBus } from "./events.js"
import { startConsoleFileLog } from "../lib/console-file-log.js"
import { setWorkflowStatus } from "../config/persist.js"
import { runIssueQueue } from "./issues.js"
import type { WorkflowRuntime } from "./types.js"

export type WorkflowOptions = {
  /** 外部注入的事件总线，供 terminal UI 订阅；不传则内部创建 */
  eventBus?: WorkflowEventBus
}

/** 配置 status 为 finish 时抛出，main 层静默退出（exit 0、不通知） */
export class WorkflowFinishedError extends Error {
  constructor() {
    super("Workflow status is finish, skipping")
  }
}

export const runWorkflow = async (args: ParsedArgs, options?: WorkflowOptions): Promise<string | undefined> => {
  const configPath = path.resolve(args.config)
  const config = await loadConfig(configPath)
  const configDir = path.dirname(configPath)
  const prompts = await loadPrompts(config, configDir)

  if (config.status === "finish") {
    throw new WorkflowFinishedError()
  }

  const workflowName = path.basename(configPath, path.extname(configPath))
  const fileLog = await startConsoleFileLog(config.projectDir, workflowName)
  console.log(`[Log] Console output: ${fileLog.filePath}`)
  await setWorkflowStatus(configPath, "implementing", config)

  if (config.title) {
    console.log(`[Workflow] Task: ${config.title}`)
  }

  const hasGit = await isGitRepo(config.projectDir)
  const startBaseSha = await getReviewBaselineSha(config.projectDir)
  if (startBaseSha) {
    console.log(`[Workflow] Review baseline: ${startBaseSha}`)
  } else if (hasGit) {
    console.log("[Workflow] Review baseline: (no commits yet — will diff from repo start after implement)")
  } else {
    console.log("[Workflow] Review baseline: (not a git repo)")
  }

  const eventBus = options?.eventBus ?? createWorkflowEventBus()
  eventBus.publish({ type: "workflow_init", title: config.title })

  const runtime: WorkflowRuntime = {
    args,
    baseSha: startBaseSha,
    config,
    configPath,
    eventBus,
    finalFixerTouched: false,
    finalFixerPane: "",
    finalReviewerPane: "",
    hasGit,
    implementerPane: "",
    issueIndex: 0,
    prompts,
    reviewerPane: "",
    startBaseSha,
  }

  try {
    await runIssueQueue(runtime, configPath)
    return config.title
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Agent CLI 启动失败")) {
      eventBus.publish({ type: "fail", reason: error.message })
    }
    throw error
  } finally {
    fileLog.restore()
    await fileLog.close()
  }
}
