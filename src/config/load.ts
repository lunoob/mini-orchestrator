import { access as fsAccess, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  IMPLEMENT_RESULT_END,
  IMPLEMENT_RESULT_START,
  REVIEW_RESULT_END,
  REVIEW_RESULT_START,
} from "../lib/prompt-delimiters.js"
import type { IssueConfig, LoadedPrompts, ParsedArgs, PromptConfig, WorkflowConfig } from "../types.js"
import { render } from "../lib/utils.js"

const TEST_DRIVEN_DEVELOPMENT_SKILL_PATH =
  "~/.agents/skills/test-driven-development/SKILL.md"

const DEFAULT_IMPLEMENT_SKILLS = [
  TEST_DRIVEN_DEVELOPMENT_SKILL_PATH,
]

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

const resolveOptionalPath = (value: string | undefined) => (value ? path.resolve(value) : undefined)

const parseMaxReviewRounds = (value: string) => {
  const rounds = Number(value)
  if (!Number.isInteger(rounds) || rounds < 1) {
    throw new Error(`[Config] Invalid maxReviewRounds: ${value}`)
  }
  return rounds
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
  fileConfig.issues.forEach((issue, index) => {
    if (!issue.title) throw new Error(`[Config] issues[${index}].title is required`)
    if (!issue.specPath) throw new Error(`[Config] issues[${index}].specPath is required`)
  })

  for (let i = 0; i < fileConfig.issues.length; i += 1) {
    try { await fsAccess(fileConfig.issues[i].specPath) } catch {
      throw new Error(`[Config] Issue ${i} spec file not found: ${fileConfig.issues[i].specPath}`)
    }
  }

  const implementerUpdate = args["implementer-update"]
  const reviewerUpdate = args["reviewer-update"]

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

  return {
    ...fileConfig,
    implementer: {
      ...fileConfig.implementer,
      updateCommand: implementerUpdate ?? fileConfig.implementer.updateCommand,
    },
    maxReviewRounds,
    projectDir,
    prompts,
    reviewer: {
      ...fileConfig.reviewer,
      updateCommand: reviewerUpdate ?? fileConfig.reviewer.updateCommand,
    },
    issues: fileConfig.issues,
  } as WorkflowConfig
}

const readPrompt = async (configDir: string, file: string) =>
  readFile(path.resolve(configDir, file), "utf8")

const injectOutputFormat = (template: string, outputFormat: string) =>
  render(template, { outputFormat })

const loadOutputFormat = async (
  configDir: string,
  partialPath: string,
  delimiterStart: string,
  delimiterEnd: string,
) => {
  const template = await readPrompt(configDir, partialPath)
  return render(template, { delimiterEnd, delimiterStart })
}

export const loadPrompts = async (config: WorkflowConfig, configDir: string): Promise<LoadedPrompts> => {
  const [implementOutput, reviewOutput] = await Promise.all([
    loadOutputFormat(
      configDir,
      config.prompts.outputFormatImplement ?? DEFAULT_IMPLEMENT_OUTPUT_PARTIAL,
      IMPLEMENT_RESULT_START,
      IMPLEMENT_RESULT_END,
    ),
    loadOutputFormat(
      configDir,
      config.prompts.outputFormatReview ?? DEFAULT_REVIEW_OUTPUT_PARTIAL,
      REVIEW_RESULT_START,
      REVIEW_RESULT_END,
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
    controllerImplementer: injectOutputFormat(controllerImplementer, implementOutput),
    controllerReReview: injectOutputFormat(controllerReReview, reviewOutput),
    implement: injectOutputFormat(implement, implementOutput),
    postReviewCheck: injectOutputFormat(postReviewCheck, implementOutput),
    reReview: injectOutputFormat(reReview, reviewOutput),
    review: injectOutputFormat(review, reviewOutput),
    revise: injectOutputFormat(revise, implementOutput),
  }
}

const stripSkillFrontmatter = (content: string) => {
  const match = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/)
  return match ? match[1].trim() : content.trim()
}

const expandHome = (skillPath: string) => {
  if (skillPath === "~") return os.homedir()
  if (skillPath.startsWith("~/")) return path.join(os.homedir(), skillPath.slice(2))
  return skillPath
}

export const resolveSkillPath = (configDir: string, skillPath: string) => {
  const expanded = expandHome(skillPath)
  return path.isAbsolute(expanded) ? expanded : path.resolve(configDir, expanded)
}

const loadSkill = async (configDir: string, skillPath: string) => {
  const resolvedPath = resolveSkillPath(configDir, skillPath)
  try {
    await fsAccess(resolvedPath)
  } catch {
    throw new Error(`[Config] Skill not found: ${skillPath} (resolved to ${resolvedPath})`)
  }
  const content = await readFile(resolvedPath, "utf8")
  return stripSkillFrontmatter(content)
}

const skillSectionTitle = (skillPath: string) => {
  const dirname = path.basename(path.dirname(skillPath))
  return dirname === ".agents" ? path.basename(path.dirname(path.dirname(skillPath))) : dirname
}

export const loadImplementSkills = async (config: WorkflowConfig, configDir: string) => {
  const skillPaths = config.skills?.implement ?? DEFAULT_IMPLEMENT_SKILLS
  return loadSkillSections(configDir, skillPaths)
}

const loadSkillSections = async (configDir: string, skillPaths: string[]) => {
  const sections = await Promise.all(
    skillPaths.map(async (skillPath) => {
      const body = await loadSkill(configDir, skillPath)
      return `### ${skillSectionTitle(skillPath)}\n\n${body}`
    }),
  )
  return sections.join("\n\n---\n\n")
}
