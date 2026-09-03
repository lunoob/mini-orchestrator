import { access as fsAccess, readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import type {
  AgentConfig,
  AgentInputConfig,
  IssueConfig,
  IssueState,
  LoadedPrompts,
  MaxRoundsConfig,
  PromptConfig,
  WorkflowConfig,
  WorkflowStatus,
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
const DEFAULT_FINAL_POST_CHECK_PROMPT = path.join(PROJECT_ROOT, "prompts/final-post-check.md")
const DEFAULT_POST_CHECK_BODY_PARTIAL = path.join(PROJECT_ROOT, "prompts/partials/post-check-body.md")
const DEFAULT_ACCEPTANCE_PROMPT = path.join(PROJECT_ROOT, "prompts/acceptance.md")
const DEFAULT_IMPLEMENT_OUTPUT_PARTIAL = path.join(PROJECT_ROOT, "prompts/partials/implement-output.md")
const DEFAULT_REVIEW_OUTPUT_PARTIAL = path.join(PROJECT_ROOT, "prompts/partials/review-output.md")
const DEFAULT_FINAL_REVIEW_PROMPT = path.join(PROJECT_ROOT, "prompts/final-review.md")
const DEFAULT_FINAL_FIX_PROMPT = path.join(PROJECT_ROOT, "prompts/final-fix.md")

const DEFAULT_WORKFLOW_MAX_ROUNDS = 8
const DEFAULT_FINAL_MAX_ROUNDS = 3
const LEGACY_FIELDS = ["maxReviewRounds", "implementer", "reviewer", "finalGate"] as const

const ISSUE_STATES: readonly IssueState[] = ["ready", "review", "finish"]
const WORKFLOW_STATUSES: readonly WorkflowStatus[] = ["implementing", "reviewing", "finish"]

const parseRounds = (value: unknown, field: string, fallback: number) => {
  if (value === undefined) return fallback
  const rounds = Number(value)
  if (!Number.isInteger(rounds) || rounds < 1) {
    throw new Error(`[Config] Invalid ${field}: ${value}`)
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

const parseWorkflowStatus = (value: unknown): WorkflowStatus | undefined => {
  if (value === undefined) return undefined
  if (typeof value === "string" && (WORKFLOW_STATUSES as readonly string[]).includes(value)) {
    return value as WorkflowStatus
  }
  throw new Error("[Config] status must be one of: implementing, reviewing, finish")
}

export const loadConfig = async (configPath: string) => {
  const content = await readFile(configPath, "utf8")
  const fileConfig = JSON.parse(content) as Record<string, unknown>

  const legacyField = LEGACY_FIELDS.find(field => field in fileConfig)
  if (legacyField) {
    throw new Error(`[Config] Legacy field "${legacyField}" is no longer supported; use the grouped config fields`)
  }

  const projectDir = fileConfig.projectDir
  if (typeof projectDir !== "string" || !projectDir) {
    throw new Error("[Config] projectDir is required in workflow config")
  }

  const rawTitle = fileConfig.title
  if (rawTitle !== undefined) {
    if (typeof rawTitle !== "string" || !rawTitle.trim()) {
      throw new Error("[Config] title must be a non-empty string when provided")
    }
  }
  const title = typeof rawTitle === "string" ? rawTitle.trim() : undefined

  const rawIssues = fileConfig.issues
  if (!Array.isArray(rawIssues) || rawIssues.length === 0) {
    throw new Error("[Config] issues is required (non-empty array)")
  }

  const issues: IssueConfig[] = rawIssues.map((issue, index) => {
    if (typeof issue !== "object" || issue === null) {
      throw new Error(`[Config] issues[${index}] must be an object`)
    }
    const item = issue as Partial<IssueConfig>
    if (!item.title) throw new Error(`[Config] issues[${index}].title is required`)
    if (!item.specPath) throw new Error(`[Config] issues[${index}].specPath is required`)
    return {
      title: item.title,
      specPath: item.specPath,
      state: parseIssueState(item.state, index),
    }
  })

  for (let i = 0; i < issues.length; i += 1) {
    try { await fsAccess(issues[i].specPath) } catch {
      throw new Error(`[Config] Issue ${i} spec file not found: ${issues[i].specPath}`)
    }
  }

  const rawPrompts = (fileConfig.prompts ?? {}) as Partial<PromptConfig>
  const prompts: PromptConfig = {
    acceptance: rawPrompts.acceptance ?? DEFAULT_ACCEPTANCE_PROMPT,
    controllerImplementer:
      rawPrompts.controllerImplementer ?? DEFAULT_CONTROLLER_IMPLEMENTER_PROMPT,
    controllerReReview:
      rawPrompts.controllerReReview ?? DEFAULT_CONTROLLER_RE_REVIEW_PROMPT,
    finalFix: rawPrompts.finalFix ?? DEFAULT_FINAL_FIX_PROMPT,
    finalPostCheck: rawPrompts.finalPostCheck ?? DEFAULT_FINAL_POST_CHECK_PROMPT,
    finalReview: rawPrompts.finalReview ?? DEFAULT_FINAL_REVIEW_PROMPT,
    implement: rawPrompts.implement ?? DEFAULT_IMPLEMENT_PROMPT,
    postCheckBody: rawPrompts.postCheckBody ?? DEFAULT_POST_CHECK_BODY_PARTIAL,
    postReviewCheck:
      rawPrompts.postReviewCheck ?? DEFAULT_POST_REVIEW_CHECK_PROMPT,
    outputFormatImplement:
      rawPrompts.outputFormatImplement ?? DEFAULT_IMPLEMENT_OUTPUT_PARTIAL,
    outputFormatReview:
      rawPrompts.outputFormatReview ?? DEFAULT_REVIEW_OUTPUT_PARTIAL,
    reReview: rawPrompts.reReview ?? DEFAULT_RE_REVIEW_PROMPT,
    review: rawPrompts.review ?? DEFAULT_REVIEW_PROMPT,
    revise: rawPrompts.revise ?? DEFAULT_REVISE_PROMPT,
  }

  const rawAgents = fileConfig.agents
  if (typeof rawAgents !== "object" || rawAgents === null) {
    throw new Error("[Config] agents is required")
  }
  const agents = rawAgents as Record<string, unknown>
  const resolveAgentInput = (input: unknown, role: string) => {
    if (typeof input !== "object" || input === null) {
      throw new Error(`[Config] agents.${role} is required`)
    }
    const agentInput = input as AgentInputConfig
    if (!agentInput.agent) throw new Error(`[Config] agents.${role}.agent is required`)
    if (!agentInput.name) throw new Error(`[Config] agents.${role}.name is required`)
    return resolveAgentConfig(agentInput)
  }

  const enableFinalGate = fileConfig.enableFinalGate ?? false
  if (typeof enableFinalGate !== "boolean") {
    throw new Error("[Config] enableFinalGate must be a boolean")
  }

  const enableAcceptanceReport = fileConfig.enableAcceptanceReport ?? true
  if (typeof enableAcceptanceReport !== "boolean") {
    throw new Error("[Config] enableAcceptanceReport must be a boolean")
  }

  const resolvedAgents = {
    implementer: resolveAgentInput(agents.implementer, "implementer"),
    reviewer: resolveAgentInput(agents.reviewer, "reviewer"),
    ...(enableFinalGate
      ? {
          gateReviewer: resolveAgentInput(agents.gateReviewer, "gateReviewer"),
          gateFixer: resolveAgentInput(agents.gateFixer, "gateFixer"),
        }
      : {}),
  }

  const rawRounds = fileConfig.maxRounds
  if (rawRounds !== undefined && (typeof rawRounds !== "object" || rawRounds === null)) {
    throw new Error("[Config] maxRounds must be an object")
  }
  const rounds = (rawRounds ?? {}) as Partial<MaxRoundsConfig>
  const maxRounds = {
    workflow: parseRounds(rounds.workflow, "maxRounds.workflow", DEFAULT_WORKFLOW_MAX_ROUNDS),
    finalGate: parseRounds(rounds.finalGate, "maxRounds.finalGate", DEFAULT_FINAL_MAX_ROUNDS),
  }

  return {
    agents: resolvedAgents,
    enableAcceptanceReport,
    enableFinalGate,
    issues,
    maxRounds,
    projectDir,
    prompts,
    status: parseWorkflowStatus(fileConfig.status),
    title,
  } as WorkflowConfig
}

const readPrompt = async (configDir: string, file: string) =>
  readFile(path.resolve(configDir, file), "utf8")

const injectOutputFormat = (template: string, outputFormat: string) =>
  render(template, { outputFormat })

const injectPostCheckBody = (template: string, postCheckBody: string) =>
  render(template, { postCheckBody })

const injectPromptPartials = (
  template: string,
  partials: { outputFormat: string, postCheckBody?: string },
) => {
  const withBody = partials.postCheckBody
    ? injectPostCheckBody(template, partials.postCheckBody)
    : template
  return injectOutputFormat(withBody, partials.outputFormat)
}

const loadOutputFormat = async (
  configDir: string,
  partialPath: string,
) => {
  return readPrompt(configDir, partialPath)
}

export const loadPrompts = async (config: WorkflowConfig, configDir: string): Promise<LoadedPrompts> => {
  const [implementOutput, reviewOutput, postCheckBody] = await Promise.all([
    loadOutputFormat(
      configDir,
      config.prompts.outputFormatImplement ?? DEFAULT_IMPLEMENT_OUTPUT_PARTIAL,
    ),
    loadOutputFormat(
      configDir,
      config.prompts.outputFormatReview ?? DEFAULT_REVIEW_OUTPUT_PARTIAL,
    ),
    loadOutputFormat(
      configDir,
      config.prompts.postCheckBody ?? DEFAULT_POST_CHECK_BODY_PARTIAL,
    ),
  ])

  const [
    acceptance,
    implement,
    reReview,
    review,
    revise,
    controllerImplementer,
    controllerReReview,
    postReviewCheck,
    finalPostCheck,
    finalReview,
    finalFix,
  ] = await Promise.all([
    readPrompt(configDir, config.prompts.acceptance ?? DEFAULT_ACCEPTANCE_PROMPT),
    readPrompt(configDir, config.prompts.implement),
    readPrompt(configDir, config.prompts.reReview ?? DEFAULT_RE_REVIEW_PROMPT),
    readPrompt(configDir, config.prompts.review),
    readPrompt(configDir, config.prompts.revise),
    readPrompt(configDir, config.prompts.controllerImplementer ?? DEFAULT_CONTROLLER_IMPLEMENTER_PROMPT),
    readPrompt(configDir, config.prompts.controllerReReview ?? DEFAULT_CONTROLLER_RE_REVIEW_PROMPT),
    readPrompt(configDir, config.prompts.postReviewCheck ?? DEFAULT_POST_REVIEW_CHECK_PROMPT),
    readPrompt(configDir, config.prompts.finalPostCheck ?? DEFAULT_FINAL_POST_CHECK_PROMPT),
    readPrompt(configDir, config.prompts.finalReview ?? DEFAULT_FINAL_REVIEW_PROMPT),
    readPrompt(configDir, config.prompts.finalFix ?? DEFAULT_FINAL_FIX_PROMPT),
  ])

  const postCheckPartials = { outputFormat: implementOutput, postCheckBody }

  return {
    acceptance: injectOutputFormat(acceptance, reviewOutput),
    controllerImplementer: injectOutputFormat(controllerImplementer, implementOutput),
    controllerReReview: injectOutputFormat(controllerReReview, reviewOutput),
    finalFix: injectOutputFormat(finalFix, implementOutput),
    finalPostCheck: injectPromptPartials(finalPostCheck, postCheckPartials),
    finalReview: injectOutputFormat(finalReview, reviewOutput),
    implement: injectOutputFormat(implement, implementOutput),
    postReviewCheck: injectPromptPartials(postReviewCheck, postCheckPartials),
    reReview: injectOutputFormat(reReview, reviewOutput),
    review: injectOutputFormat(review, reviewOutput),
    revise: injectOutputFormat(revise, implementOutput),
  }
}
