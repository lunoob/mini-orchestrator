import { access as fsAccess, readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import type {
  AgentConfig,
  AgentInputConfig,
  FinalGateConfig,
  FinalGateInputConfig,
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
const DEFAULT_IMPLEMENT_OUTPUT_PARTIAL = path.join(PROJECT_ROOT, "prompts/partials/implement-output.md")
const DEFAULT_REVIEW_OUTPUT_PARTIAL = path.join(PROJECT_ROOT, "prompts/partials/review-output.md")
const DEFAULT_FINAL_REVIEW_PROMPT = path.join(PROJECT_ROOT, "prompts/final-review.md")
const DEFAULT_FINAL_FIX_PROMPT = path.join(PROJECT_ROOT, "prompts/final-fix.md")

const DEFAULT_FINAL_MAX_ROUNDS = 3

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

const parseFinalMaxRounds = (value: unknown) => {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error("[Config] finalGate.maxRounds must be a positive integer")
  }
  return value
}

/**
 * 解析 finalGate：缺省或 enabled: false 时返回 undefined（完全保持旧行为）；
 * 启用时必须提供完整的 reviewer / fixer 角色配置，缺少任一字段即在加载阶段报错。
 */
const parseFinalGate = (raw: unknown, resolveAgentInput: (input: AgentInputConfig, role: string) => AgentConfig): FinalGateConfig | undefined => {
  if (raw === undefined) return undefined
  if (typeof raw !== "object" || raw === null) {
    throw new Error("[Config] finalGate must be an object")
  }
  const gate = raw as FinalGateInputConfig
  if (gate.enabled === false) return undefined

  const resolveFinalRole = (input: AgentInputConfig | undefined, role: string): AgentConfig => {
    if (!input || typeof input !== "object") {
      throw new Error(`[Config] finalGate.${role} is required`)
    }
    return resolveAgentInput(input, `finalGate.${role}`)
  }

  return {
    maxRounds: gate.maxRounds === undefined ? DEFAULT_FINAL_MAX_ROUNDS : parseFinalMaxRounds(gate.maxRounds),
    reviewer: resolveFinalRole(gate.reviewer, "reviewer"),
    fixer: resolveFinalRole(gate.fixer, "fixer"),
    prompts: {
      review: gate.prompts?.review ?? DEFAULT_FINAL_REVIEW_PROMPT,
      fix: gate.prompts?.fix ?? DEFAULT_FINAL_FIX_PROMPT,
    },
  }
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
    outputFormatImplement:
      fileConfig.prompts?.outputFormatImplement ?? DEFAULT_IMPLEMENT_OUTPUT_PARTIAL,
    outputFormatReview:
      fileConfig.prompts?.outputFormatReview ?? DEFAULT_REVIEW_OUTPUT_PARTIAL,
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
    finalGate: parseFinalGate(fileConfig.finalGate, resolveAgentInput),
    issues,
  } as WorkflowConfig
}

const readPrompt = async (configDir: string, file: string) =>
  readFile(path.resolve(configDir, file), "utf8")

const injectOutputFormat = (template: string, outputFormat: string) =>
  render(template, { outputFormat })

const loadOutputFormat = async (
  configDir: string,
  partialPath: string,
) => {
  return readPrompt(configDir, partialPath)
}

export const loadPrompts = async (config: WorkflowConfig, configDir: string): Promise<LoadedPrompts> => {
  const [implementOutput, reviewOutput] = await Promise.all([
    loadOutputFormat(
      configDir,
      config.prompts.outputFormatImplement ?? DEFAULT_IMPLEMENT_OUTPUT_PARTIAL,
    ),
    loadOutputFormat(
      configDir,
      config.prompts.outputFormatReview ?? DEFAULT_REVIEW_OUTPUT_PARTIAL,
    ),
  ])

  const [
    implement,
    reReview,
    review,
    revise,
    controllerImplementer,
    controllerReReview,
    postReviewCheck,
    finalReview,
    finalFix,
  ] = await Promise.all([
    readPrompt(configDir, config.prompts.implement),
    readPrompt(configDir, config.prompts.reReview ?? DEFAULT_RE_REVIEW_PROMPT),
    readPrompt(configDir, config.prompts.review),
    readPrompt(configDir, config.prompts.revise),
    readPrompt(configDir, config.prompts.controllerImplementer ?? DEFAULT_CONTROLLER_IMPLEMENTER_PROMPT),
    readPrompt(configDir, config.prompts.controllerReReview ?? DEFAULT_CONTROLLER_RE_REVIEW_PROMPT),
    readPrompt(configDir, config.prompts.postReviewCheck ?? DEFAULT_POST_REVIEW_CHECK_PROMPT),
    readPrompt(configDir, config.finalGate?.prompts.review ?? DEFAULT_FINAL_REVIEW_PROMPT),
    readPrompt(configDir, config.finalGate?.prompts.fix ?? DEFAULT_FINAL_FIX_PROMPT),
  ])

  return {
    controllerImplementer: injectOutputFormat(controllerImplementer, implementOutput),
    controllerReReview: injectOutputFormat(controllerReReview, reviewOutput),
    finalFix: injectOutputFormat(finalFix, implementOutput),
    finalReview: injectOutputFormat(finalReview, reviewOutput),
    implement: injectOutputFormat(implement, implementOutput),
    postReviewCheck: injectOutputFormat(postReviewCheck, implementOutput),
    reReview: injectOutputFormat(reReview, reviewOutput),
    review: injectOutputFormat(review, reviewOutput),
    revise: injectOutputFormat(revise, implementOutput),
  }
}
