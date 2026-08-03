import { describe, expect, it, vi } from "vitest"

import { registerNonInteractiveSignalHandlers } from "./command-signals.js"

describe("registerNonInteractiveSignalHandlers", () => {
  it("exits with conventional codes for SIGINT and SIGTERM", () => {
    const handlers = new Map<string, () => void>()
    const processRef = {
      on: vi.fn((signal: string, handler: () => void) => {
        handlers.set(signal, handler)
      }),
      removeListener: vi.fn(),
      exit: vi.fn() as unknown as (code: number) => never,
    }

    const cleanup = registerNonInteractiveSignalHandlers(processRef)

    handlers.get("SIGINT")?.()
    expect(processRef.exit).toHaveBeenCalledWith(130)

    handlers.get("SIGTERM")?.()
    expect(processRef.exit).toHaveBeenCalledWith(143)

    cleanup()
    expect(processRef.removeListener).toHaveBeenCalledTimes(2)
  })
})
