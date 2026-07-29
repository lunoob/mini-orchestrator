import { describe, expect, test, vi } from "vitest"

import type { InputRequest } from "@src/workflow/agent-outcome"
import type { PromptPort } from "@src/session/interaction-prompt"

describe("interaction-prompt", () => {
  test("maps options to select prompt and returns optionId", async () => {
    const { mapRequestToPrompt } = await import("@src/session/interaction-prompt")
    const request: InputRequest = {
      question: "Choose a framework",
      options: [
        { id: "react", label: "React", description: "UI library" },
        { id: "vue", label: "Vue" },
      ],
      allowFreeform: false,
    }

    const prompt = mapRequestToPrompt(request)
    expect(prompt.kind).toBe("select")
    if (prompt.kind === "select") {
      expect(prompt.message).toBe("Choose a framework")
      expect(prompt.options).toHaveLength(2)
      expect(prompt.options[0]).toMatchObject({ value: "react", label: "React", hint: "UI library" })
    }
  })

  test("maps options with allowFreeform to include other option", async () => {
    const { mapRequestToPrompt } = await import("@src/session/interaction-prompt")
    const request: InputRequest = {
      question: "Pick or type",
      options: [{ id: "a", label: "Option A" }],
      allowFreeform: true,
    }

    const prompt = mapRequestToPrompt(request)
    expect(prompt.kind).toBe("select")
    if (prompt.kind === "select") {
      expect(prompt.options).toHaveLength(2)
      expect(prompt.options[1]).toMatchObject({ value: "__freeform__", label: expect.stringContaining("其他") })
    }
  })

  test("maps empty options to text prompt", async () => {
    const { mapRequestToPrompt } = await import("@src/session/interaction-prompt")
    const request: InputRequest = {
      question: "Enter a value",
      allowFreeform: true,
      inputHint: "Type something",
    }

    const prompt = mapRequestToPrompt(request)
    expect(prompt.kind).toBe("text")
    if (prompt.kind === "text") {
      expect(prompt.message).toBe("Enter a value")
      expect(prompt.placeholder).toBe("Type something")
    }
  })

  test("includes recommendation in prompt message", async () => {
    const { mapRequestToPrompt } = await import("@src/session/interaction-prompt")
    const request: InputRequest = {
      question: "What to do?",
      recommendation: "Use TypeScript",
      allowFreeform: true,
    }

    const prompt = mapRequestToPrompt(request)
    expect(prompt.message).toContain("What to do?")
    expect(prompt.message).toContain("Use TypeScript")
  })

  test("PromptPort select resolves with optionId", async () => {
    const { mapRequestToPrompt, executePrompt } = await import("@src/session/interaction-prompt")
    const mockSelect = vi.fn().mockResolvedValue("react")
    const port: PromptPort = { select: mockSelect, text: vi.fn() }

    const prompt = mapRequestToPrompt({
      question: "Pick",
      options: [{ id: "react", label: "React" }, { id: "vue", label: "Vue" }],
      allowFreeform: false,
    })

    const result = await executePrompt(port, prompt)
    expect(result).toEqual({ optionId: "react" })
  })

  test("PromptPort select with freeform returns text when user picks other", async () => {
    const { mapRequestToPrompt, executePrompt } = await import("@src/session/interaction-prompt")
    const mockSelect = vi.fn().mockResolvedValue("__freeform__")
    const mockText = vi.fn().mockResolvedValue("custom value")
    const port: PromptPort = { select: mockSelect, text: mockText }

    const prompt = mapRequestToPrompt({
      question: "Pick or type",
      options: [{ id: "a", label: "A" }],
      allowFreeform: true,
    })

    const result = await executePrompt(port, prompt)
    expect(result).toEqual({ text: "custom value" })
    expect(mockText).toHaveBeenCalled()
  })

  test("PromptPort text resolves with text", async () => {
    const { mapRequestToPrompt, executePrompt } = await import("@src/session/interaction-prompt")
    const mockText = vi.fn().mockResolvedValue("user input")
    const port: PromptPort = { select: vi.fn(), text: mockText }

    const prompt = mapRequestToPrompt({
      question: "Enter something",
      allowFreeform: true,
    })

    const result = await executePrompt(port, prompt)
    expect(result).toEqual({ text: "user input" })
  })

  test("cancel returns null", async () => {
    const { mapRequestToPrompt, executePrompt } = await import("@src/session/interaction-prompt")
    const mockSelect = vi.fn().mockResolvedValue(undefined) // Clack returns undefined on cancel
    const port: PromptPort = { select: mockSelect, text: vi.fn() }

    const prompt = mapRequestToPrompt({
      question: "Pick",
      options: [{ id: "a", label: "A" }],
      allowFreeform: false,
    })

    const result = await executePrompt(port, prompt)
    expect(result).toBeNull()
  })

  test("required text rejects empty input", async () => {
    const { mapRequestToPrompt, executePrompt } = await import("@src/session/interaction-prompt")
    const mockText = vi.fn().mockResolvedValue("")
    const port: PromptPort = { select: vi.fn(), text: mockText }

    const prompt = mapRequestToPrompt({
      question: "Enter something",
      allowFreeform: true,
    })

    const result = await executePrompt(port, prompt)
    // Empty required text should be treated as cancel
    expect(result).toBeNull()
  })
})
