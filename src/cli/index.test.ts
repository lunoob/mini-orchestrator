import { afterEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { printHelp } from "./index.js"

const packageJson = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
) as { scripts?: Record<string, string> }

describe("printHelp", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("does not show an executable command prefix", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined)

    printHelp()

    expect(log).toHaveBeenCalledWith(expect.stringContaining("--config <path>"))
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("--testStatus"))
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("mini-orch"))
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("start-orchestrator"))
  })

  it("provides the status test through the package script", () => {
    expect(packageJson.scripts?.["test:status"]).toBe("tsx ./src/test-status.ts")
  })
})
