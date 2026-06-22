#!/usr/bin/env -S npx tsx

import { spawn } from "node:child_process"
import { readFile } from "node:fs/promises"
import path from "node:path"

type AgentConfig = {
  command: string
  name: string
}

type PromptConfig = {
  implement: string
  review: string
  revise: string
}

type WorkflowConfig = {
  implementer: AgentConfig
  maxReviewRounds: number
  projectDir: string
  prompts: PromptConfig
  reviewer: AgentConfig
  specPath: string
}

type PaneIdResult = {
  result: {
    pane: {
      pane_id: string
    }
  }
}

const main = async () => {
  assertHerdrEnv()

  const args = parseArgs(process.argv.slice(2))
  const configPath = getConfigPath(args)
  const config = await loadConfig(configPath)
  const prompts = await loadPrompts(config, path.dirname(configPath))

  const reuseCurrentPane = isFlagEnabled(args, "reuse-current-pane")

  const implementerPane = await startAgent(config.projectDir, config.implementer)
  const reviewerPane = reuseCurrentPane
    ? await getCurrentPane()
    : await startAgent(config.projectDir, config.reviewer)

  if (reuseCurrentPane) {
    console.log(`Reusing current pane as reviewer: ${reviewerPane}`)
  }

  await sendTask(
    implementerPane,
    render(prompts.implement, {
      specPath: config.specPath,
      maxReviewRounds: String(config.maxReviewRounds),
    }),
  )
  await waitForIdle(implementerPane)

  for (let round = 1; round <= config.maxReviewRounds; round += 1) {
    await sendTask(reviewerPane, render(prompts.review, { round: String(round) }))
    await waitForIdle(reviewerPane)

    const reviewOutput = await readAgentOutput(reviewerPane, 220)
    printSection(`Review Round ${round}`, reviewOutput)

    if (hasStatus(reviewOutput, "REVIEW_PASS")) {
      console.log(`\nWorkflow finished: review passed in round ${round}.`)
      return
    }

    if (round === config.maxReviewRounds) {
      throw new Error(`Review failed after ${config.maxReviewRounds} rounds.`)
    }

    await sendTask(
      implementerPane,
      render(prompts.revise, {
        round: String(round),
        reviewOutput,
      }),
    )
    await waitForIdle(implementerPane)
  }
}

void main().catch((error) => {
  console.error(`\nWorkflow failed: ${getErrorMessage(error)}`)
  process.exitCode = 1
})

function assertHerdrEnv() {
  if (process.env.HERDR_ENV === "1") return
  throw new Error("HERDR_ENV is not set to 1. Please run this inside a herdr pane.")
}

function parseArgs(argv: string[]) {
  const args: Record<string, string> = {}

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith("--")) continue

    const key = arg.slice(2)
    const value = argv[index + 1]
    if (!value || value.startsWith("--")) {
      args[key] = "true"
      continue
    }

    args[key] = value
    index += 1
  }

  return args
}

function isFlagEnabled(args: Record<string, string>, key: string) {
  const value = args[key]
  if (value === undefined) return false
  return value !== "false"
}

function getConfigPath(args: Record<string, string>) {
  const configPath = args["config"]
  if (configPath) return path.resolve(configPath)

  throw new Error("Missing required argument --config /absolute/path/to/workflow.json")
}

async function loadConfig(configPath: string) {
  const content = await readFile(configPath, "utf8")
  const config = JSON.parse(content) as WorkflowConfig

  if (!config.projectDir) throw new Error("workflow config is missing projectDir")
  if (!config.specPath) throw new Error("workflow config is missing specPath")
  if (!config.prompts?.implement) throw new Error("workflow config is missing prompts.implement")
  if (!config.prompts?.review) throw new Error("workflow config is missing prompts.review")
  if (!config.prompts?.revise) throw new Error("workflow config is missing prompts.revise")

  return {
    ...config,
    maxReviewRounds: Number(config.maxReviewRounds || 4),
  }
}

async function loadPrompts(config: WorkflowConfig, configDir: string) {
  const implement = await readPrompt(configDir, config.prompts.implement)
  const review = await readPrompt(configDir, config.prompts.review)
  const revise = await readPrompt(configDir, config.prompts.revise)
  return { implement, review, revise }
}

async function readPrompt(configDir: string, file: string) {
  return readFile(path.resolve(configDir, file), "utf8")
}

function render(template: string, values: Record<string, string>) {
  return template.replaceAll(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) => values[key] ?? "")
}

async function getCurrentPane() {
  const output = await runHerdr(["pane", "current"])
  const parsed = JSON.parse(output) as PaneIdResult
  return parsed.result.pane.pane_id
}

async function startAgent(projectDir: string, agent: AgentConfig) {
  const output = await runHerdr([
    "agent",
    "start",
    agent.name,
    "--cwd",
    projectDir,
    "--no-focus",
    "--",
    ...splitCommand(agent.command),
  ])
  const parsed = JSON.parse(output) as PaneIdResult
  return parsed.result.pane.pane_id
}

async function sendTask(paneId: string, prompt: string) {
  await runHerdr(["agent", "send", paneId, prompt])
  await runHerdr(["pane", "send-keys", paneId, "enter"])
}

async function waitForIdle(paneId: string) {
  await runHerdr(["agent", "wait", paneId, "--status", "idle", "--timeout", "1800000"])
}

async function readAgentOutput(paneId: string, lines: number) {
  return runHerdr([
    "agent",
    "read",
    paneId,
    "--source",
    "recent-unwrapped",
    "--lines",
    String(lines),
  ])
}

function hasStatus(output: string, status: string) {
  return output.includes(`STATUS: ${status}`)
}

function printSection(title: string, body: string) {
  console.log(`\n=== ${title} ===\n`)
  console.log(body.trim())
}

function splitCommand(command: string) {
  const parts: string[] = []
  let current = ""
  let quote: '"' | "'" | undefined

  for (const char of command) {
    if ((char === '"' || char === "'") && !quote) {
      quote = char
      continue
    }

    if (char === quote) {
      quote = undefined
      continue
    }

    if (char === " " && !quote) {
      if (current) parts.push(current)
      current = ""
      continue
    }

    current += char
  }

  if (current) parts.push(current)
  return parts
}

async function runHerdr(args: string[]) {
  const { code, stderr, stdout } = await run("herdr", args)
  if (code === 0) return stdout.trim()

  throw new Error(stderr.trim() || `herdr ${args.join(" ")} failed with code ${code}`)
}

function run(command: string, args: string[]) {
  return new Promise<{ code: number | null; stderr: string; stdout: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString()
    })
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString()
    })

    child.on("error", reject)
    child.on("close", (code) => resolve({ code, stdout, stderr }))
  })
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  return String(error)
}
