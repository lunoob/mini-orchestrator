import type { InputRequest } from "../workflow/agent-outcome.js"

// ---- Prompt port (injectable for testing) ----

export type SelectOption = {
  value: string
  label: string
  hint?: string
}

export type PromptPort = {
  select: (message: string, options: SelectOption[]) => Promise<string | undefined>
  text: (message: string, placeholder?: string) => Promise<string | undefined>
}

export type PromptMapping =
  | { kind: "select"; message: string; options: SelectOption[] }
  | { kind: "text"; message: string; placeholder?: string }

const FREEFORM_SENTINEL = "__freeform__"

/**
 * Map an InputRequest to a prompt mapping that can be executed by a PromptPort.
 */
export const mapRequestToPrompt = (request: InputRequest): PromptMapping => {
  const parts: string[] = [request.question]
  if (request.recommendation) parts.push(`💡 建议: ${request.recommendation}`)
  const message = parts.join("\n")

  if (request.options && request.options.length > 0) {
    const options: SelectOption[] = request.options.map(opt => ({
      value: opt.id,
      label: opt.label,
      hint: opt.description,
    }))
    if (request.allowFreeform) {
      options.push({ value: FREEFORM_SENTINEL, label: "其他（手动输入）" })
    }
    return { kind: "select", message, options }
  }

  // No options: text input
  return { kind: "text", message, placeholder: request.inputHint }
}

/**
 * Execute a prompt mapping using the given PromptPort.
 * Returns the user's response, or null if they cancelled.
 */
export const executePrompt = async (
  port: PromptPort,
  prompt: PromptMapping,
): Promise<{ optionId?: string; text?: string } | null> => {
  if (prompt.kind === "select") {
    const selected = await port.select(prompt.message, prompt.options)
    if (selected === undefined) return null // cancelled
    if (selected === FREEFORM_SENTINEL) {
      const text = await port.text("请输入:", undefined)
      if (text === undefined || text.trim() === "") return null
      return { text }
    }
    return { optionId: selected }
  }

  // text
  const text = await port.text(prompt.message, prompt.placeholder)
  if (text === undefined || text.trim() === "") return null
  return { text }
}

/**
 * Create a real PromptPort using @clack/prompts.
 * Only use in the runner process (requires TTY).
 */
export const createClackPromptPort = async (): Promise<PromptPort> => {
  const clack = await import("@clack/prompts")
  return {
    select: async (message, options) => {
      const result = await clack.select({
        message,
        options: options.map(opt => ({
          value: opt.value,
          label: opt.label,
          hint: opt.hint,
        })),
      })
      if (clack.isCancel(result)) return undefined
      return result as string
    },
    text: async (message, placeholder) => {
      const result = await clack.text({
        message,
        placeholder,
      })
      if (clack.isCancel(result)) return undefined
      return result as string
    },
  }
}
