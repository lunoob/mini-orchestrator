import { access, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type { LoadedPrompts, ParsedArgs, WorkflowConfig } from "./types.js"

const PLANNING_WITH_FILES_SKILL = "~/.agents/skills/planning-with-files/SKILL.md"

const DEFAULT_IMPLEMENT_SKILLS = [
  PLANNING_WITH_FILES_SKILL,
  "./skills/implementing-from-spec/SKILL.md",
  "./skills/test-driven-development/SKILL.md",
]

const DEFAULT_REVISE_SKILLS = ["./skills/receiving-code-review/SKILL.md"]

const DEFAULT_CONTROLLER_IMPLEMENTER_PROMPT = "./prompts/controller-implementer.md"
const DEFAULT_CONTROLLER_RE_REVIEW_PROMPT = "./prompts/controller-re-review.md"

const resolveOptionalPath = (value: string | undefined) => (value ? path.resolve(value) : undefined)

const parseMaxReviewRounds = (value: string) => {
  const rounds = Number(value)
  if (!Number.isInteger(rounds) || rounds < 1) {
    throw new Error(`Invalid maxReviewRounds: ${value}`)
  }
  return rounds
}

export const loadConfig = async (configPath: string, args: ParsedArgs) => {
  const content = await readFile(configPath, "utf8")
  const fileConfig = JSON.parse(content) as Partial<WorkflowConfig>

  const projectDir = resolveOptionalPath(args.projectDir) ?? fileConfig.projectDir
  const specPath = resolveOptionalPath(args.specPath) ?? fileConfig.specPath
  const maxReviewRounds =
    args.maxReviewRounds !== undefined
      ? parseMaxReviewRounds(args.maxReviewRounds)
      : Number(fileConfig.maxReviewRounds ?? 4)

  if (!projectDir) throw new Error("projectDir is required (workflow config or --projectDir)")
  if (!specPath) throw new Error("specPath is required (workflow config or --specPath)")
  if (!fileConfig.prompts?.implement) throw new Error("workflow config is missing prompts.implement")
  if (!fileConfig.prompts?.review) throw new Error("workflow config is missing prompts.review")
  if (!fileConfig.prompts?.revise) throw new Error("workflow config is missing prompts.revise")
  if (!fileConfig.implementer) throw new Error("workflow config is missing implementer")
  if (!fileConfig.reviewer) throw new Error("workflow config is missing reviewer")

  return {
    ...fileConfig,
    implementer: fileConfig.implementer,
    maxReviewRounds,
    projectDir,
    prompts: fileConfig.prompts,
    reviewer: fileConfig.reviewer,
    specPath,
  } as WorkflowConfig
}

const readPrompt = async (configDir: string, file: string) =>
  readFile(path.resolve(configDir, file), "utf8")

export const loadPrompts = async (config: WorkflowConfig, configDir: string): Promise<LoadedPrompts> => {
  const implement = await readPrompt(configDir, config.prompts.implement)
  const review = await readPrompt(configDir, config.prompts.review)
  const revise = await readPrompt(configDir, config.prompts.revise)
  const controllerImplementer = await readPrompt(
    configDir,
    config.prompts.controllerImplementer ?? DEFAULT_CONTROLLER_IMPLEMENTER_PROMPT,
  )
  const controllerReReview = await readPrompt(
    configDir,
    config.prompts.controllerReReview ?? DEFAULT_CONTROLLER_RE_REVIEW_PROMPT,
  )
  return { controllerImplementer, controllerReReview, implement, review, revise }
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
    await access(resolvedPath)
  } catch {
    throw new Error(`Skill not found: ${skillPath} (resolved to ${resolvedPath})`)
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

export const loadReviseSkills = async (config: WorkflowConfig, configDir: string) => {
  const skillPaths = config.skills?.revise ?? DEFAULT_REVISE_SKILLS
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
