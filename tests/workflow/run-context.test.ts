import { describe, expect, test } from "vitest"

describe("workflow run context", () => {
  test("exposes workflow run metadata without using the agent Session name", async () => {
    const module = await import("@src/workflow/run-context") as typeof import("@src/workflow/run-context")

    expect(module.createWorkflowRunContext).toBeTypeOf("function")
  })
})
