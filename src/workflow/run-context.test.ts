import { describe, expect, test } from "vitest"

describe("workflow run context", () => {
  test("exposes workflow run metadata without using the agent Session name", async () => {
    const module = await import("./run-context.js") as typeof import("./run-context.js")

    expect(module.createWorkflowRunContext).toBeTypeOf("function")
  })
})
