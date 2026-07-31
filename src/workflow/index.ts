import path from "node:path"

import { loadConfig, loadPrompts } from "../config/load.js"
import { getReviewBaselineSha, isGitRepo } from "../git/index.js"
import { parseNeedsCheckMode } from "../review/needs-check.js"
import type { ParsedArgs } from "../types.js"
import { createWorkflowEventBus, type WorkflowEventBus } from "./events.js"
import { runIssueQueue } from "./issues.js"
import { runWorkflowResume } from "./resume.js"
import type { WorkflowRuntime } from "./types.js"

export type WorkflowOptions = {
  /** 外部注入的事件总线，供 terminal UI 订阅；不传则内部创建 */
  eventBus?: WorkflowEventBus
}

export const runWorkflow = async (args: ParsedArgs, options?: WorkflowOptions) => {
  if (args["resume-from"]) {
    return runWorkflowResume(args, options)
  }

  const configPath = path.resolve(args.config)
  const config = await loadConfig(configPath, args)
  const configDir = path.dirname(configPath)
  const prompts = await loadPrompts(config, configDir)
  const needsCheckMode = parseNeedsCheckMode(args)

  const hasGit = await isGitRepo(config.projectDir)
  const baseSha = await getReviewBaselineSha(config.projectDir)
  if (baseSha) {
    console.log(`[Workflow] Review baseline: ${baseSha}`)
  } else if (hasGit) {
    console.log("[Workflow] Review baseline: (no commits yet — will diff from repo start after implement)")
  } else {
    console.log("[Workflow] Review baseline: (not a git repo)")
  }

  if (needsCheckMode === "llm") {
    console.log("[Workflow] Needs-check mode: llm (pause with checkpoint on REVIEW_NEEDS_CHECK)")
  }

  const eventBus = options?.eventBus ?? createWorkflowEventBus()

  const runtime: WorkflowRuntime = {
    args,
    baseSha,
    config,
    configPath,
    eventBus,
    hasGit,
    implementerPane: "",
    issueIndex: 0,
    needsCheckMode,
    prompts,
    reviewerPane: "",
  }

  // 通知 UI 工作流实际开始时间，对齐计时起点
  eventBus.publish({ type: "workflow_started", startedAt: Date.now() })

  await runIssueQueue(runtime, configPath)
}
