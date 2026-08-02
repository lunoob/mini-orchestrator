import { afterEach, describe, expect, it, vi } from "vitest"

import { printHelp } from "./index.js"

describe("printHelp", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("does not show an executable command prefix", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined)

    printHelp()

    expect(log).toHaveBeenCalledWith(expect.stringContaining("--config <path>"))
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("mini-orch"))
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("start-orchestrator"))
  })
})
