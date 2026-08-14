import { describe, expect, it } from "vitest"

import {
  buildBootstrapCommand,
  buildResumeArgs,
  parseBootstrapOutput,
  resolveAgentConfig,
} from "./agents.js"

describe("resolveAgentConfig", () => {
  it("resolves codex with model", () => {
    const config = resolveAgentConfig({
      agent: "codex",
      model: "gpt-5.6-terra",
      name: "reviewer",
    })

    expect(config.command).toBe("codex --model gpt-5.6-terra")
    expect(config.integrationAgent).toBe("codex")
    expect(config.updateCommand).toBe("codex update")
  })

  it("resolves codex with effort", () => {
    const config = resolveAgentConfig({
      agent: "codex",
      effort: "high",
      model: "gpt-5.6-terra",
      name: "reviewer",
    })

    expect(config.command).toBe(
      'codex --model gpt-5.6-terra -c model_reasoning_effort="high"',
    )
    expect(config.effort).toBe("high")
  })

  it("resolves cursor with cursor-agent cli", () => {
    const config = resolveAgentConfig({
      agent: "cursor",
      model: "composer",
      name: "implementer",
    })

    expect(config.command).toBe("cursor-agent --trust --yolo --model composer")
    expect(config.integrationAgent).toBe("cursor")
    expect(config.updateCommand).toBe("cursor-agent update")
  })

  it("resolves cursor with effort in model suffix", () => {
    const config = resolveAgentConfig({
      agent: "cursor",
      model: "composer-2.5-high",
      name: "implementer",
    })

    expect(config.command).toBe("cursor-agent --trust --yolo --model composer-2.5-high")
  })

  it("throws when cursor has effort field", () => {
    expect(() =>
      resolveAgentConfig({
        agent: "cursor",
        effort: "high",
        model: "composer-2.5",
        name: "implementer",
      }),
    ).toThrow(/effort is not supported for cursor/)
  })

  it("resolves claude with updateCommand", () => {
    const config = resolveAgentConfig({
      agent: "claude",
      model: "haiku",
      name: "implementer",
    })

    expect(config.command).toBe("claude --model haiku")
    expect(config.updateCommand).toBe("claude update")
  })

  it("resolves claude with effort", () => {
    const config = resolveAgentConfig({
      agent: "claude",
      effort: "high",
      model: "haiku",
      name: "implementer",
    })

    expect(config.command).toBe("claude --model haiku --effort high")
    expect(config.effort).toBe("high")
  })

  it("throws for invalid codex effort", () => {
    expect(() =>
      resolveAgentConfig({
        agent: "codex",
        effort: "max",
        model: "gpt-5.6-terra",
        name: "reviewer",
      }),
    ).toThrow(/Invalid reviewer\.effort "max"/)
  })

  it("throws for unknown agent", () => {
    expect(() =>
      resolveAgentConfig({ agent: "unknown", model: "x", name: "impl" }),
    ).toThrow(/Unknown agent "unknown"/)
  })
})

describe("buildBootstrapCommand", () => {
  const metaPrompt = "TEST_META_PROMPT"

  it("builds claude bootstrap shell command with model and effort, ending with 2>/dev/null", () => {
    const config = resolveAgentConfig({
      agent: "claude",
      model: "sonnet",
      effort: "high",
      name: "test",
    })

    const cmd = buildBootstrapCommand(config, metaPrompt)

    expect(typeof cmd).toBe("string")
    expect(cmd).toMatch(/^claude/)
    expect(cmd).toContain("-p")
    expect(cmd).toContain(metaPrompt)
    expect(cmd).toContain("--model")
    expect(cmd).toContain("sonnet")
    expect(cmd).toContain("--effort")
    expect(cmd).toContain("high")
    // 末尾显式 2>/dev/null
    expect(cmd.endsWith("2>/dev/null")).toBe(true)
  })

  it("builds codex bootstrap shell command with model and effort", () => {
    const config = resolveAgentConfig({
      agent: "codex",
      model: "gpt-5.6-terra",
      effort: "medium",
      name: "test",
    })

    const cmd = buildBootstrapCommand(config, metaPrompt)

    expect(typeof cmd).toBe("string")
    expect(cmd).toMatch(/^codex/)
    expect(cmd).toContain("exec")
    expect(cmd).toContain("--model")
    expect(cmd).toContain("gpt-5.6-terra")
    expect(cmd.endsWith("2>/dev/null")).toBe(true)
  })

  it("builds cursor bootstrap shell command with model", () => {
    const config = resolveAgentConfig({
      agent: "cursor",
      model: "composer-2.5-high",
      name: "test",
    })

    const cmd = buildBootstrapCommand(config, metaPrompt)

    expect(typeof cmd).toBe("string")
    expect(cmd).toMatch(/^cursor-agent --trust --yolo/)
    expect(cmd).toContain("-p")
    expect(cmd).toContain("--model")
    expect(cmd).toContain("composer-2.5-high")
    expect(cmd.endsWith("2>/dev/null")).toBe(true)
  })

  it("builds claude bootstrap shell command without effort when not configured", () => {
    const config = resolveAgentConfig({
      agent: "claude",
      model: "haiku",
      name: "test",
    })

    const cmd = buildBootstrapCommand(config, metaPrompt)

    expect(typeof cmd).toBe("string")
    expect(cmd).toMatch(/^claude/)
    expect(cmd).toContain("-p")
    expect(cmd).toContain("--model")
    expect(cmd).toContain("haiku")
    expect(cmd).not.toContain("--effort")
    expect(cmd.endsWith("2>/dev/null")).toBe(true)
  })
})

describe("buildResumeArgs", () => {
  it("builds claude resume CLI args with model and effort", () => {
    const config = resolveAgentConfig({
      agent: "claude",
      model: "sonnet",
      effort: "xhigh",
      name: "test",
    })

    const args = buildResumeArgs(config, "resume-abc-123")

    expect(args).toContain("--resume resume-abc-123")
    expect(args).toContain("--model sonnet")
    expect(args).toContain("--effort xhigh")
  })

  it("builds codex resume CLI args with model and effort", () => {
    const config = resolveAgentConfig({
      agent: "codex",
      model: "gpt-5.6-terra",
      effort: "low",
      name: "test",
    })

    const args = buildResumeArgs(config, "resume-xyz-456")

    expect(args).toContain("resume resume-xyz-456")
    expect(args).toContain("--model gpt-5.6-terra")
    expect(args).toContain('model_reasoning_effort="low"')
  })

  it("builds cursor resume CLI args with model", () => {
    const config = resolveAgentConfig({
      agent: "cursor",
      model: "composer-2.5",
      name: "test",
    })

    const args = buildResumeArgs(config, "resume-cur-789")

    expect(args).toContain("--trust --yolo")
    expect(args).toContain("--resume resume-cur-789")
    expect(args).toContain("--model composer-2.5")
  })
})

describe("parseBootstrapOutput", () => {
  it("parses valid JSON with resumeId and jsonl", () => {
    const stdout = '{"resumeId":"abc-123","jsonl":"/tmp/session.jsonl"}'
    const result = parseBootstrapOutput(stdout, "claude")

    expect(result).toEqual({
      provider: "claude",
      resumeId: "abc-123",
      jsonl: "/tmp/session.jsonl",
      offset: 0,
    })
  })

  it("rejects JSON with surrounding text (strict parsing)", () => {
    const stdout = 'Starting session...\n{"resumeId":"xyz-789","jsonl":"/home/user/data.jsonl"}\nSession ready.'
    const result = parseBootstrapOutput(stdout, "codex")

    expect(result).toBeUndefined()
  })

  it("returns undefined for non-JSON output", () => {
    expect(parseBootstrapOutput("No JSON here", "claude")).toBeUndefined()
  })

  it("returns undefined when resumeId is missing", () => {
    const stdout = '{"jsonl":"/tmp/session.jsonl"}'
    expect(parseBootstrapOutput(stdout, "claude")).toBeUndefined()
  })

  it("returns undefined when jsonl is missing", () => {
    const stdout = '{"resumeId":"abc-123"}'
    expect(parseBootstrapOutput(stdout, "claude")).toBeUndefined()
  })

  it("returns undefined when fields are empty strings", () => {
    const stdout = '{"resumeId":"","jsonl":""}'
    expect(parseBootstrapOutput(stdout, "claude")).toBeUndefined()
  })

  it("returns undefined for empty stdout", () => {
    expect(parseBootstrapOutput("", "claude")).toBeUndefined()
  })

  it("returns undefined for null/undefined values in JSON", () => {
    const stdout = '{"resumeId":null,"jsonl":null}'
    expect(parseBootstrapOutput(stdout, "claude")).toBeUndefined()
  })
})
