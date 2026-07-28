import path from "node:path"

import { loadConfig, loadPrompts } from "../config/load.js"
import { getReviewBaselineSha, isGitRepo } from "../git/index.js"
import { parseNeedsCheckMode } from "../review/needs-check.js"
import type { ParsedArgs } from "../types.js"
import { runIssueQueue } from "./issues.js"
import { runWorkflowResume } from "./resume.js"
import type { WorkflowRuntime } from "./types.js"
import { createSessionApiServer } from "../session/server.js"
import { createSessionClient } from "../session/client.js"

export const runWorkflow = async (args: ParsedArgs) => {
  if (args["resume-from"]) {
    return runWorkflowResume(args)
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

  const sessionServer = createSessionApiServer({ runDirectory: path.join(config.projectDir, ".orchestrator") })
  const { baseUrl, token } = await sessionServer.start()
  const runtime: WorkflowRuntime = {
    args,
    baseSha,
    config,
    hasGit,
    implementerPane: "",
    issueIndex: 0,
    needsCheckMode,
    prompts,
    reviewerPane: "",
    sessionBaseUrl: baseUrl,
    sessionClient: createSessionClient({ baseUrl, token }),
  }

  try {
    await runIssueQueue(runtime, configPath)
  } finally {
    await sessionServer.stop()
  }
}
