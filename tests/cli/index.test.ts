import { afterEach, describe, expect, it, vi } from "vitest"

import { printHelp } from "@src/cli/index"

describe("printHelp", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("shows mini-orch as the executable command", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined)

    printHelp()

    expect(log).toHaveBeenCalledWith(expect.stringContaining("mini-orch --config"))
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("start-orchestrator"))
  })
})
