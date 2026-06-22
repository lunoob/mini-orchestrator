import { spawn } from "node:child_process"

import type { AgentConfig, AgentStartResult, PaneCurrentResult } from "./types.js"
import { splitCommand } from "./utils.js"

const run = (command: string, args: string[]) =>
  new Promise<{ code: number | null; stderr: string; stdout: string }>((resolve, reject) => {
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

export const runHerdr = async (args: string[]) => {
  const { code, stderr, stdout } = await run("herdr", args)
  if (code === 0) return stdout.trim()

  throw new Error(stderr.trim() || `herdr ${args.join(" ")} failed with code ${code}`)
}

export const getCurrentPane = async () => {
  const output = await runHerdr(["pane", "current"])
  const parsed = JSON.parse(output) as PaneCurrentResult
  return parsed.result.pane.pane_id
}

export const startAgent = async (projectDir: string, agent: AgentConfig) => {
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
  const parsed = JSON.parse(output) as AgentStartResult
  return parsed.result.agent.pane_id
}

export const sendTask = async (paneId: string, prompt: string) => {
  await runHerdr(["agent", "send", paneId, prompt])
  await runHerdr(["pane", "send-keys", paneId, "enter"])
}

export const waitForIdle = async (paneId: string) => {
  await runHerdr(["agent", "wait", paneId, "--status", "idle", "--timeout", "1800000"])
}

export const readAgentOutput = async (paneId: string, lines: number) =>
  runHerdr([
    "agent",
    "read",
    paneId,
    "--source",
    "recent-unwrapped",
    "--lines",
    String(lines),
  ])
