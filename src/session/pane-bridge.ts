import type { PaneSplitResult } from "../types.js"
import { runHerdr, tryRunHerdr } from "../agent/subprocess.js"

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
