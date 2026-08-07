import { afterEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { parseArgs, printHelp } from "./index.js"

const packageJson = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
) as { scripts?: Record<string, string> }

describe("CLI help", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("shows the invoked command in usage", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined)

    printHelp("local-mini-orch")

    expect(log).toHaveBeenCalledWith(expect.stringContaining("Usage: local-mini-orch [options]"))
    expect(log).toHaveBeenCalledWith(expect.stringContaining("local-mini-orch skill <command> [options]"))
    expect(log).toHaveBeenCalledWith(expect.stringContaining("--config <path>"))
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("--testStatus"))
  })

  it("provides the status test through the package script", () => {
    expect(packageJson.scripts?.["test:status"]).toBe("tsx ./src/test-status.ts")
  })

  it("rejects removed workflow override options", () => {
    expect(() => parseArgs(["--projectDir", "/tmp/project"])).toThrow("--projectDir")
    expect(() => parseArgs(["--maxReviewRounds", "6"])).toThrow("--maxReviewRounds")
  })

  it("uses the alias name provided by the environment", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
    const previous = process.env.MINI_ORCH_COMMAND
    process.env.MINI_ORCH_COMMAND = "local-mini-orch"

    try {
      printHelp()
      expect(log).toHaveBeenCalledWith(expect.stringContaining("Usage: local-mini-orch [options]"))
    } finally {
      if (previous === undefined) delete process.env.MINI_ORCH_COMMAND
      else process.env.MINI_ORCH_COMMAND = previous
    }
  })
})
