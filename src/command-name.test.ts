import { describe, expect, it } from "vitest"

import { getCommandName } from "./command-name.js"

describe("getCommandName", () => {
  it("prefers the temporary command name from the environment", () => {
    expect(getCommandName("/tmp/bin/mini-orch.mjs", "local-mini-orch")).toBe("local-mini-orch")
  })

  it("recognizes the published executable name", () => {
    expect(getCommandName("/tmp/bin/mini-orch.mjs")).toBe("mini-orch")
  })

  it("falls back to the published name for development entrypoints", () => {
    expect(getCommandName("/tmp/src/main.ts")).toBe("mini-orch")
  })
})
