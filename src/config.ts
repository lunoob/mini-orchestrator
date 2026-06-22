import { readFile } from "node:fs/promises"
import path from "node:path"

import type { LoadedPrompts, ParsedArgs, WorkflowConfig } from "./types.js"

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
  return { implement, review, revise }
}
