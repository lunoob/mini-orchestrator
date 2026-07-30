import { describe, expect, test } from "vitest"

import { buildToolLabel } from "@src/session/adapters/cursor"

describe("buildToolLabel", () => {
  test("includes whitelisted file_path in label", () => {
    expect(buildToolLabel("read_file", { file_path: "/src/index.ts" })).toBe("read_file /src/index.ts")
  })

  test("includes whitelisted path in label", () => {
    expect(buildToolLabel("write_file", { path: "src/out.ts" })).toBe("write_file src/out.ts")
  })

  test("does not expose shell command arguments", () => {
    const label = buildToolLabel("run_terminal_cmd", {
      command: "curl -H 'Authorization: Bearer secret-token' https://api.example.com",
    })
    expect(label).toBe("run_terminal_cmd")
    expect(label).not.toContain("secret-token")
    expect(label).not.toContain("Authorization")
  })

  test("returns tool name only when args are missing or unrecognized", () => {
    expect(buildToolLabel("grep", undefined)).toBe("grep")
    expect(buildToolLabel("grep", { pattern: "foo" })).toBe("grep")
  })
})
