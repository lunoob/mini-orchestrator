import { spawn } from "node:child_process"

import type { PaneSplitResult } from "../types.js"

const DELAY_MS = 800

const runHerdrCommand = async (command: string, args: string[]) => {
  await new Promise(resolve => setTimeout(resolve, DELAY_MS))
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

const runHerdr = async (args: string[]) => {
  const { code, stderr, stdout } = await runHerdrCommand("herdr", args)
  if (code === 0) return stdout.trim()

  throw new Error(`[Session] ${stderr.trim() || `herdr ${args.join(" ")} failed with code ${code}`}`)
}

const tryRunHerdr = async (args: string[]) => {
  const { code, stderr, stdout } = await runHerdrCommand("herdr", args)
  return { code, stderr: stderr.trim(), stdout: stdout.trim() }
}

export type PaneBridge = {
  bootstrap: (paneId: string, command: string) => Promise<void>
  close: (paneId: string) => Promise<void>
  split: (projectDir: string) => Promise<string>
  watch?: (paneId: string, onClosed: (error: Error) => void, options?: { pollIntervalMs?: number }) => () => void
}

type PaneCommands = {
  run: typeof runHerdr
  tryRun: typeof tryRunHerdr
}

const isPaneNotFound = (stderr: string) =>
  /"code"\s*:\s*"pane_not_found"|"pane_not_found"|pane .+ not found/i.test(stderr)

const parsePaneId = (output: string) => {
  const parsed = JSON.parse(output) as PaneSplitResult
  const paneId = parsed.result?.pane?.pane_id
  if (!paneId) throw new Error("[Session] Herdr did not return a pane id")
  return paneId
}

const hasPane = (output: string, paneId: string) => {
  const parsed = JSON.parse(output) as { result?: { panes?: Array<{ pane_id?: string }> } }
  return parsed.result?.panes?.some(pane => pane.pane_id === paneId) ?? false
}

export const createPaneBridge = (commands: PaneCommands = { run: runHerdr, tryRun: tryRunHerdr }): PaneBridge => {
  const bootstrapped = new Set<string>()

  const split = async (projectDir: string) => parsePaneId(await commands.run([
    "pane", "split", "--current", "--direction", "right", "--cwd", projectDir, "--no-focus",
  ]))

  const bootstrap = async (paneId: string, command: string) => {
    if (bootstrapped.has(paneId)) return
    await commands.run(["pane", "send-text", paneId, command])
    await commands.run(["pane", "send-keys", paneId, "enter"])
    bootstrapped.add(paneId)
  }

  const close = async (paneId: string) => {
    const result = await commands.tryRun(["pane", "close", paneId])
    if (result.code === 0 || isPaneNotFound(result.stderr)) return
    throw new Error(`[Session] ${result.stderr || `herdr pane close ${paneId} failed with code ${result.code}`}`)
  }

  const watch = (paneId: string, onClosed: (error: Error) => void, options: { pollIntervalMs?: number } = {}) => {
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const check = async () => {
      if (!active) return
      try {
        if (!hasPane(await commands.run(["pane", "list"]), paneId)) {
          active = false
          onClosed(new Error(`[Session] Herdr pane ${paneId} was closed`))
          return
        }
      } catch (error) {
        active = false
        onClosed(error instanceof Error ? error : new Error(String(error)))
        return
      }
      timer = setTimeout(() => { void check() }, options.pollIntervalMs ?? 1_000)
    }
    void check()
    return () => {
      active = false
      if (timer) clearTimeout(timer)
    }
  }

  return { bootstrap, close, split, watch }
}
