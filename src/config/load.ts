import { access as fsAccess, readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import type {
  AgentInputConfig,
  IssueConfig,
  IssueState,
  LoadedPrompts,
  ParsedArgs,
  PromptConfig,
  WorkflowConfig,
} from "../types.js"
import { render } from "../lib/utils.js"
import { resolveAgentConfig } from "./agents.js"

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

const DEFAULT_IMPLEMENT_PROMPT = path.join(PROJECT_ROOT, "prompts/implement.md")
const DEFAULT_REVIEW_PROMPT = path.join(PROJECT_ROOT, "prompts/review.md")
const DEFAULT_RE_REVIEW_PROMPT = path.join(PROJECT_ROOT, "prompts/re-review.md")
const DEFAULT_REVISE_PROMPT = path.join(PROJECT_ROOT, "prompts/revise.md")
const DEFAULT_CONTROLLER_IMPLEMENTER_PROMPT = path.join(PROJECT_ROOT, "prompts/controller-implementer.md")
const DEFAULT_CONTROLLER_RE_REVIEW_PROMPT = path.join(PROJECT_ROOT, "prompts/controller-re-review.md")
const DEFAULT_POST_REVIEW_CHECK_PROMPT = path.join(PROJECT_ROOT, "prompts/post-review-check.md")

const ISSUE_STATES: readonly IssueState[] = ["ready", "review", "finish"]

const resolveOptionalPath = (value: string | undefined) => (value ? path.resolve(value) : undefined)

const parseMaxReviewRounds = (value: string) => {
  const rounds = Number(value)
  if (!Number.isInteger(rounds) || rounds < 1) {
    throw new Error(`[Config] Invalid maxReviewRounds: ${value}`)
  }
  return rounds
}

const parseIssueState = (value: unknown, index: number): IssueState => {
  if (value === undefined) return "ready"
  if (typeof value === "string" && (ISSUE_STATES as readonly string[]).includes(value)) {
    return value as IssueState
  }
  throw new Error(`[Config] issues[${index}].state must be one of: ready, review, finish`)
}

export const loadConfig = async (configPath: string, args: ParsedArgs) => {
  const content = await readFile(configPath, "utf8")
  const fileConfig = JSON.parse(content) as Partial<WorkflowConfig>

  const projectDir = resolveOptionalPath(args.projectDir) ?? fileConfig.projectDir
  const maxReviewRounds =
    args.maxReviewRounds !== undefined
      ? parseMaxReviewRounds(args.maxReviewRounds)
      : Number(fileConfig.maxReviewRounds ?? 8)

  if (!projectDir) throw new Error("[Config] projectDir is required (workflow config or --projectDir)")

  if (!fileConfig.issues || fileConfig.issues.length === 0) {
    throw new Error("[Config] issues is required (non-empty array)")
  }
  const issues: IssueConfig[] = fileConfig.issues.map((issue, index) => {
    if (!issue.title) throw new Error(`[Config] issues[${index}].title is required`)
    if (!issue.specPath) throw new Error(`[Config] issues[${index}].specPath is required`)
    return {
      title: issue.title,
      specPath: issue.specPath,
      state: parseIssueState(issue.state, index),
    }
  })

  for (let i = 0; i < issues.length; i += 1) {
    try { await fsAccess(issues[i].specPath) } catch {
      throw new Error(`[Config] Issue ${i} spec file not found: ${issues[i].specPath}`)
    }
  }

  // 弃用警告：outputFormatImplement/outputFormatReview 已移除
  const rawPrompts = fileConfig.prompts as Record<string, unknown> | undefined
  if (rawPrompts?.outputFormatImplement !== undefined || rawPrompts?.outputFormatReview !== undefined) {
    console.warn(
      "[Config] ⚠️ prompts.outputFormatImplement 和 prompts.outputFormatReview 已弃用，将被忽略。" +
      "输出格式现在由 JSON outcome 契约统一管理，无需自定义 partial。",
    )
  }

  const prompts: PromptConfig = {
    implement: fileConfig.prompts?.implement ?? DEFAULT_IMPLEMENT_PROMPT,
    reReview: fileConfig.prompts?.reReview ?? DEFAULT_RE_REVIEW_PROMPT,
    review: fileConfig.prompts?.review ?? DEFAULT_REVIEW_PROMPT,
    revise: fileConfig.prompts?.revise ?? DEFAULT_REVISE_PROMPT,
    controllerImplementer:
      fileConfig.prompts?.controllerImplementer ?? DEFAULT_CONTROLLER_IMPLEMENTER_PROMPT,
    controllerReReview:
      fileConfig.prompts?.controllerReReview ?? DEFAULT_CONTROLLER_RE_REVIEW_PROMPT,
    postReviewCheck:
      fileConfig.prompts?.postReviewCheck ?? DEFAULT_POST_REVIEW_CHECK_PROMPT,
  }

  if (!fileConfig.implementer) throw new Error("[Config] workflow config is missing implementer")
  if (!fileConfig.reviewer) throw new Error("[Config] workflow config is missing reviewer")

  const resolveAgentInput = (input: AgentInputConfig, role: string) => {
    if (!input.agent) throw new Error(`[Config] ${role}.agent is required`)
    if (!input.name) throw new Error(`[Config] ${role}.name is required`)
    return resolveAgentConfig(input)
  }

  return {
    ...fileConfig,
    implementer: resolveAgentInput(fileConfig.implementer, "implementer"),
    maxReviewRounds,
    projectDir,
    prompts,
    reviewer: resolveAgentInput(fileConfig.reviewer, "reviewer"),
    issues,
  } as WorkflowConfig
}

const readPrompt = async (configDir: string, file: string) =>
  readFile(path.resolve(configDir, file), "utf8")

export const loadPrompts = async (config: WorkflowConfig, configDir: string): Promise<LoadedPrompts> => {
  const [
    implement,
    reReview,
    review,
    revise,
    controllerImplementer,
    controllerReReview,
    postReviewCheck,
  ] = await Promise.all([
    readPrompt(configDir, config.prompts.implement),
    readPrompt(configDir, config.prompts.reReview ?? DEFAULT_RE_REVIEW_PROMPT),
    readPrompt(configDir, config.prompts.review),
    readPrompt(configDir, config.prompts.revise),
    readPrompt(configDir, config.prompts.controllerImplementer ?? DEFAULT_CONTROLLER_IMPLEMENTER_PROMPT),
    readPrompt(configDir, config.prompts.controllerReReview ?? DEFAULT_CONTROLLER_RE_REVIEW_PROMPT),
    readPrompt(configDir, config.prompts.postReviewCheck ?? DEFAULT_POST_REVIEW_CHECK_PROMPT),
  ])

  return {
    controllerImplementer,
    controllerReReview,
    implement,
    postReviewCheck,
    reReview,
    review,
    revise,
  }
}
