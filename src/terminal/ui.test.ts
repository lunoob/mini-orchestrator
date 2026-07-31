import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"

import type { WorkflowSnapshot, WorkflowEventBus } from "../workflow/events.js"
import { createBlessedUI, createPlainTextUI } from "./ui.js"

// 每个测试都会注册进程信号监听器，提高阈值避免误报
process.setMaxListeners(50)

// ── Mock Blessed ──

const createMockBlessed = () => {
  const screenListeners: Record<string, Function[]> = {}
  const logKeyListeners: Record<string, Function[]> = {}

  const log = vi.fn().mockReturnValue({
    log: vi.fn(),
    height: 50,
    focus: vi.fn(),
    key: vi.fn((keys: string[], handler: Function) => {
      for (const k of keys) {
        if (!logKeyListeners[k]) logKeyListeners[k] = []
        logKeyListeners[k].push(handler)
      }
    }),
    scroll: vi.fn(),
    setScrollPerc: vi.fn(),
    getScrollPerc: vi.fn().mockReturnValue(100),
    getScrollHeight: vi.fn().mockReturnValue(100),
    childBase: 0,
    __listeners: logKeyListeners,
  })

  const box = vi.fn().mockReturnValue({
    setContent: vi.fn(),
    height: 1,
  })

  const screen = vi.fn().mockReturnValue({
    append: vi.fn(),
    render: vi.fn(),
    destroy: vi.fn(),
    clear: vi.fn(),
    on: vi.fn((event: string, handler: Function) => {
      if (!screenListeners[event]) screenListeners[event] = []
      screenListeners[event].push(handler)
    }),
    key: vi.fn(),
    program: {
      showCursor: vi.fn(),
      normalBuffer: vi.fn(),
      clear: vi.fn(),
      write: vi.fn(),
    },
    cols: 80,
    rows: 24,
    __listeners: screenListeners,
    __emit: (event: string) => {
      for (const handler of screenListeners[event] ?? []) {
        handler()
      }
    },
  })

  return { screen, log, box } as any
}

// ── Helper ──

const createSnapshot = (overrides: Partial<WorkflowSnapshot> = {}): WorkflowSnapshot => ({
  issueIndex: 0,
  issueCount: 3,
  issueTitle: "Auth",
  phase: "implement",
  reviewRound: 1,
  maxReviewRounds: 8,
  implementerStatus: "working",
  reviewerStatus: "idle",
  elapsedMs: 65000,
  needsInput: null,
  invalidOutput: null,
  terminalState: null,
  startedAt: Date.now() - 65000,
  ...overrides,
})

const createEventBus = (): WorkflowEventBus => {
  const subscribers = new Set<(event: any) => void>()
  return {
    publish: vi.fn(),
    subscribe: vi.fn((subscriber: (event: any) => void) => {
      subscribers.add(subscriber)
      return () => subscribers.delete(subscriber)
    }),
    getSnapshot: vi.fn(() => createSnapshot()),
    reset: vi.fn(),
    requestInteraction: vi.fn(),
    setInteractionHandler: vi.fn(),
  }
}

// ── Tests ──

describe("TerminalUI", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe("initialization", () => {
    it("creates screen with smartCSR and fullUnicode for CJK support", () => {
      const blessed = createMockBlessed()
      const eventBus = createEventBus()
      createBlessedUI(eventBus, blessed)

      expect(blessed.screen).toHaveBeenCalledWith(
        expect.objectContaining({ smartCSR: true, forceUnicode: true, fullUnicode: true })
      )
    })

    it("creates log widget and status panel", () => {
      const blessed = createMockBlessed()
      const eventBus = createEventBus()
      createBlessedUI(eventBus, blessed)

      expect(blessed.log).toHaveBeenCalled()
      expect(blessed.box).toHaveBeenCalled()
    })

    it("subscribes to workflow events", () => {
      const blessed = createMockBlessed()
      const eventBus = createEventBus()
      createBlessedUI(eventBus, blessed)

      expect(eventBus.subscribe).toHaveBeenCalled()
    })

    it("renders initial snapshot immediately", () => {
      const blessed = createMockBlessed()
      const statusBox = { setContent: vi.fn(), height: 1 }
      blessed.box.mockReturnValue(statusBox)

      const eventBus = createEventBus()
      createBlessedUI(eventBus, blessed)

      // Should have rendered initial snapshot
      expect(statusBox.setContent).toHaveBeenCalled()
    })

    it("re-renders on resize", () => {
      const blessed = createMockBlessed()
      const statusBox = { setContent: vi.fn(), height: 1 }
      blessed.box.mockReturnValue(statusBox)

      const eventBus = createEventBus()
      const screenInstance = blessed.screen()
      createBlessedUI(eventBus, blessed)

      statusBox.setContent.mockClear()

      // Simulate resize
      screenInstance.cols = 100
      screenInstance.rows = 30
      screenInstance.__emit("resize")

      // Should have re-rendered
      expect(statusBox.setContent).toHaveBeenCalled()
    })
  })

  describe("log sink", () => {
    it("appends to log widget", () => {
      const blessed = createMockBlessed()
      const logWidget = { log: vi.fn(), height: 50, key: vi.fn(), scroll: vi.fn(), focus: vi.fn(), setScrollPerc: vi.fn(), getScrollHeight: vi.fn().mockReturnValue(100), childBase: 0 }
      blessed.log.mockReturnValue(logWidget)

      const eventBus = createEventBus()
      const ui = createBlessedUI(eventBus, blessed)

      ui.getLogSink().log("Test message")
      expect(logWidget.log).toHaveBeenCalledWith("Test message")
    })

    it("preserves order", () => {
      const blessed = createMockBlessed()
      const logWidget = { log: vi.fn(), height: 50, key: vi.fn(), scroll: vi.fn(), focus: vi.fn(), setScrollPerc: vi.fn(), getScrollHeight: vi.fn().mockReturnValue(100), childBase: 0 }
      blessed.log.mockReturnValue(logWidget)

      const eventBus = createEventBus()
      const ui = createBlessedUI(eventBus, blessed)

      const sink = ui.getLogSink()
      sink.log("First")
      sink.log("Second")
      sink.log("Third")

      expect(logWidget.log).toHaveBeenCalledTimes(3)
      expect(logWidget.log.mock.calls).toEqual([
        ["First"],
        ["Second"],
        ["Third"],
      ])
    })

    it("does not duplicate on status update", () => {
      const blessed = createMockBlessed()
      const logWidget = { log: vi.fn(), height: 50, key: vi.fn(), scroll: vi.fn(), focus: vi.fn(), setScrollPerc: vi.fn(), getScrollHeight: vi.fn().mockReturnValue(100), childBase: 0 }
      blessed.log.mockReturnValue(logWidget)

      const eventBus = createEventBus()
      const ui = createBlessedUI(eventBus, blessed)

      ui.getLogSink().log("Original message")
      ui.updateStatus(createSnapshot())

      expect(logWidget.log).toHaveBeenCalledTimes(1)
      expect(logWidget.log).toHaveBeenCalledWith("Original message")
    })
  })

  describe("status rendering", () => {
    it("formats elapsed time as HH:MM:SS", () => {
      const blessed = createMockBlessed()
      const eventBus = createEventBus()
      const ui = createBlessedUI(eventBus, blessed)

      expect(ui.formatElapsed(0)).toBe("执行时间：00:00:00")
      expect(ui.formatElapsed(65000)).toBe("执行时间：00:01:05")
      expect(ui.formatElapsed(3661000)).toBe("执行时间：01:01:01")
      expect(ui.formatElapsed(3600000)).toBe("执行时间：01:00:00")
    })

    it("renders compact status when terminal is wide enough", () => {
      const blessed = createMockBlessed()
      const statusBox = { setContent: vi.fn(), height: 1 }
      blessed.box.mockReturnValue(statusBox)

      const eventBus = createEventBus()
      const ui = createBlessedUI(eventBus, blessed)

      ui.updateStatus(createSnapshot({
        issueIndex: 0,
        issueCount: 3,
        issueTitle: "Auth",
        phase: "implement",
        reviewRound: 1,
        maxReviewRounds: 8,
        implementerStatus: "working",
        reviewerStatus: "idle",
        elapsedMs: 65000,
      }))

      expect(statusBox.setContent).toHaveBeenCalled()
      const content = statusBox.setContent.mock.calls[0][0] as string
      expect(content).toContain("Issue: 1/3")
      expect(content).toContain("Auth")
      expect(content).toContain("implement")
      expect(content).toContain("R1/8")
      expect(content).toContain("执行时间：00:01:05")
    })

    it("renders wrapped status when terminal is narrow", () => {
      const blessed = createMockBlessed()
      const screenInstance = { append: vi.fn(), render: vi.fn(), destroy: vi.fn(), clear: vi.fn(), on: vi.fn(), key: vi.fn(), program: { showCursor: vi.fn(), clear: vi.fn(), write: vi.fn() }, cols: 40, rows: 24 }
      blessed.screen.mockReturnValue(screenInstance)

      const statusBox = { setContent: vi.fn(), height: 1 }
      blessed.box.mockReturnValue(statusBox)

      const eventBus = createEventBus()
      const ui = createBlessedUI(eventBus, blessed)

      ui.updateStatus(createSnapshot())

      expect(statusBox.setContent).toHaveBeenCalled()
    })

    it("handles needs_input state", () => {
      const blessed = createMockBlessed()
      const statusBox = { setContent: vi.fn(), height: 1 }
      blessed.box.mockReturnValue(statusBox)

      const eventBus = createEventBus()
      const ui = createBlessedUI(eventBus, blessed)

      ui.updateStatus(createSnapshot({
        implementerStatus: "needs_input",
        needsInput: {
          agent: "implementer",
          provider: "claude",
          reason: "Which database?",
        },
      }))

      // 取最后一次 setContent 调用（初始渲染会先调用一次）
      const lastCall = statusBox.setContent.mock.calls.length - 1
      const content = statusBox.setContent.mock.calls[lastCall][0] as string
      expect(content).toContain("implementer")
      expect(content).toContain("Which database?")
    })

    it("handles invalid_output state", () => {
      const blessed = createMockBlessed()
      const statusBox = { setContent: vi.fn(), height: 1 }
      blessed.box.mockReturnValue(statusBox)

      const eventBus = createEventBus()
      const ui = createBlessedUI(eventBus, blessed)

      ui.updateStatus(createSnapshot({
        reviewerStatus: "invalid_output",
        invalidOutput: {
          agent: "reviewer",
          provider: "codex",
          reason: "Missing STATUS",
        },
      }))

      const lastCall = statusBox.setContent.mock.calls.length - 1
      const content = statusBox.setContent.mock.calls[lastCall][0] as string
      expect(content).toContain("reviewer")
      expect(content).toContain("Missing STATUS")
    })

    it("shows terminal state when workflow completes", () => {
      const blessed = createMockBlessed()
      const statusBox = { setContent: vi.fn(), height: 1 }
      blessed.box.mockReturnValue(statusBox)

      const eventBus = createEventBus()
      const ui = createBlessedUI(eventBus, blessed)

      ui.updateStatus(createSnapshot({ terminalState: "completed" }))

      const lastCall = statusBox.setContent.mock.calls.length - 1
      const content = statusBox.setContent.mock.calls[lastCall][0] as string
      expect(content).toContain("completed")
    })
  })

  describe("timer", () => {
    // 辅助：模拟 workflow_started 事件以启动计时器
    const fireWorkflowStarted = (eventBus: WorkflowEventBus) => {
      // 通过 subscribe 注册的 handler 来触发 workflow_started
      const subscribeFn = eventBus.subscribe as ReturnType<typeof vi.fn>
      for (const call of subscribeFn.mock.calls) {
        const handler = call[0] as (event: any) => void
        handler({ type: "workflow_started", startedAt: Date.now() })
      }
    }

    it("does not start timer until workflow_started event", () => {
      const blessed = createMockBlessed()
      const eventBus = createEventBus()
      const ui = createBlessedUI(eventBus, blessed)

      // 计时器不会在 UI 创建时启动，而是等待 workflow_started 事件
      expect(ui.isTimerRunning()).toBe(false)
    })

    it("starts timer on workflow_started event", () => {
      const blessed = createMockBlessed()
      const eventBus = createEventBus()
      const ui = createBlessedUI(eventBus, blessed)

      fireWorkflowStarted(eventBus)

      expect(ui.isTimerRunning()).toBe(true)
    })

    it("continues during needs_input", () => {
      const blessed = createMockBlessed()
      const eventBus = createEventBus()
      const ui = createBlessedUI(eventBus, blessed)

      fireWorkflowStarted(eventBus)
      vi.advanceTimersByTime(5000)

      const elapsed = ui.getElapsedMs()
      expect(elapsed).toBeGreaterThanOrEqual(5000)
    })

    it("stops on stopTimer call", () => {
      const blessed = createMockBlessed()
      const eventBus = createEventBus()
      const ui = createBlessedUI(eventBus, blessed)

      ui.stopTimer()
      expect(ui.isTimerRunning()).toBe(false)

      const elapsed1 = ui.getElapsedMs()
      vi.advanceTimersByTime(5000)
      const elapsed2 = ui.getElapsedMs()

      expect(elapsed2).toBe(elapsed1)
    })

    it("auto-stops on terminalState completed", () => {
      const blessed = createMockBlessed()
      const eventBus = createEventBus()
      const ui = createBlessedUI(eventBus, blessed)

      fireWorkflowStarted(eventBus)
      vi.advanceTimersByTime(3000)
      expect(ui.isTimerRunning()).toBe(true)

      ui.updateStatus(createSnapshot({ terminalState: "completed" }))

      expect(ui.isTimerRunning()).toBe(false)
      const elapsed1 = ui.getElapsedMs()
      vi.advanceTimersByTime(5000)
      expect(ui.getElapsedMs()).toBe(elapsed1)
    })

    it("auto-stops on terminalState failed", () => {
      const blessed = createMockBlessed()
      const eventBus = createEventBus()
      const ui = createBlessedUI(eventBus, blessed)

      fireWorkflowStarted(eventBus)
      ui.updateStatus(createSnapshot({ terminalState: "failed" }))
      expect(ui.isTimerRunning()).toBe(false)
    })

    it("continues on terminalState paused (checkpoint/interaction)", () => {
      const blessed = createMockBlessed()
      const eventBus = createEventBus()
      const ui = createBlessedUI(eventBus, blessed)

      fireWorkflowStarted(eventBus)
      ui.updateStatus(createSnapshot({ terminalState: "paused" }))
      // paused = 等待用户操作或 checkpoint，计时继续
      expect(ui.isTimerRunning()).toBe(true)
    })

    it("continues during needs_input (not terminal)", () => {
      const blessed = createMockBlessed()
      const eventBus = createEventBus()
      const ui = createBlessedUI(eventBus, blessed)

      fireWorkflowStarted(eventBus)
      ui.updateStatus(createSnapshot({
        implementerStatus: "needs_input",
        needsInput: { agent: "implementer", provider: "claude", reason: "Which?" },
      }))

      // Timer should still be running during needs_input
      expect(ui.isTimerRunning()).toBe(true)
    })
  })

  describe("teardown", () => {
    it("destroys screen", () => {
      const blessed = createMockBlessed()
      const screenInstance = { append: vi.fn(), render: vi.fn(), destroy: vi.fn(), clear: vi.fn(), on: vi.fn(), key: vi.fn(), program: { showCursor: vi.fn(), normalBuffer: vi.fn(), clear: vi.fn(), write: vi.fn() }, cols: 80, rows: 24 }
      blessed.screen.mockReturnValue(screenInstance)

      const eventBus = createEventBus()
      const ui = createBlessedUI(eventBus, blessed)

      ui.teardown()
      expect(screenInstance.destroy).toHaveBeenCalled()
    })

    it("stops timer", () => {
      const blessed = createMockBlessed()
      const eventBus = createEventBus()
      const ui = createBlessedUI(eventBus, blessed)

      ui.teardown()
      expect(ui.isTimerRunning()).toBe(false)
    })

    it("unsubscribes from events", () => {
      const blessed = createMockBlessed()
      const unsubscribe = vi.fn()
      const eventBus = {
        ...createEventBus(),
        subscribe: vi.fn(() => unsubscribe),
      }

      const ui = createBlessedUI(eventBus, blessed)
      ui.teardown()

      expect(unsubscribe).toHaveBeenCalled()
    })

    it("calls screen.destroy for full terminal cleanup including cursor", () => {
      const blessed = createMockBlessed()
      const screenInstance = { append: vi.fn(), render: vi.fn(), destroy: vi.fn(), clear: vi.fn(), on: vi.fn(), key: vi.fn(), program: { showCursor: vi.fn(), normalBuffer: vi.fn(), clear: vi.fn(), write: vi.fn() }, cols: 80, rows: 24 }
      blessed.screen.mockReturnValue(screenInstance)

      const eventBus = createEventBus()
      const ui = createBlessedUI(eventBus, blessed)

      ui.teardown()
      expect(screenInstance.destroy).toHaveBeenCalled()
    })

    it("flushes log history to correct stream on teardown", () => {
      const blessed = createMockBlessed()
      const logWidget = { log: vi.fn(), height: 50, key: vi.fn(), scroll: vi.fn(), focus: vi.fn(), setScrollPerc: vi.fn(), getScrollHeight: vi.fn().mockReturnValue(100), childBase: 0 }
      blessed.log.mockReturnValue(logWidget)

      const eventBus = createEventBus()
      const ui = createBlessedUI(eventBus, blessed)
      const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)

      ui.getLogSink().log("stdout line")
      ui.getLogSink().logStderr("stderr line")

      ui.teardown()

      expect(stdoutSpy).toHaveBeenCalledWith("stdout line\n")
      expect(stderrSpy).toHaveBeenCalledWith("stderr line\n")

      stdoutSpy.mockRestore()
      stderrSpy.mockRestore()
    })

    it("calls destroy before flushing logs to stdout", () => {
      const blessed = createMockBlessed()
      const screenInstance = {
        append: vi.fn(),
        render: vi.fn(),
        destroy: vi.fn(),
        clear: vi.fn(),
        on: vi.fn(),
        key: vi.fn(),
        program: { showCursor: vi.fn(), normalBuffer: vi.fn(), clear: vi.fn(), write: vi.fn() },
        cols: 80,
        rows: 24,
      }
      blessed.screen.mockReturnValue(screenInstance)

      const eventBus = createEventBus()
      const ui = createBlessedUI(eventBus, blessed)
      const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

      ui.getLogSink().log("Log line")
      ui.teardown()

      // destroy should be called before log flush
      expect(screenInstance.destroy).toHaveBeenCalled()
      expect(writeSpy).toHaveBeenCalledWith("Log line\n")

      const destroyOrder = screenInstance.destroy.mock.invocationCallOrder[0]
      const writeOrder = writeSpy.mock.invocationCallOrder[0]
      expect(destroyOrder).toBeLessThan(writeOrder)

      writeSpy.mockRestore()
    })
  })

  describe("non-TTY mode", () => {
    it("does not use blessed", () => {
      const eventBus = createEventBus()
      const ui = createPlainTextUI(eventBus)

      // Plain text UI should not crash
      expect(ui.isTimerRunning()).toBe(false)
    })

    it("provides plain text log sink via process.stdout.write", () => {
      const eventBus = createEventBus()
      const ui = createPlainTextUI(eventBus)
      const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

      ui.getLogSink().log("Test message")
      expect(writeSpy).toHaveBeenCalledWith("Test message\n")

      writeSpy.mockRestore()
    })

    it("has no-op updateStatus", () => {
      const eventBus = createEventBus()
      const ui = createPlainTextUI(eventBus)

      // Should not throw
      ui.updateStatus(createSnapshot())
    })

    it("has no-op teardown", () => {
      const eventBus = createEventBus()
      const ui = createPlainTextUI(eventBus)

      // Should not throw
      ui.teardown()
    })
  })

  describe("scrolling", () => {
    it("enables key input on screen", () => {
      const blessed = createMockBlessed()
      const screenInstance = blessed.screen()
      const eventBus = createEventBus()
      createBlessedUI(eventBus, blessed)

      // screen should have key bindings
      expect(screenInstance.on).toHaveBeenCalled()
    })

    it("sets log widget focusable", () => {
      const blessed = createMockBlessed()
      const logWidget = { log: vi.fn(), height: 50, focus: vi.fn(), key: vi.fn(), scroll: vi.fn(), setScrollPerc: vi.fn(), getScrollHeight: vi.fn().mockReturnValue(100), childBase: 0 }
      blessed.log.mockReturnValue(logWidget)

      const eventBus = createEventBus()
      createBlessedUI(eventBus, blessed)

      // logWidget should have focus capability
      expect(typeof logWidget.focus).toBe("function")
    })

    it("auto-scrolls to bottom when new log arrives and following", () => {
      const blessed = createMockBlessed()
      const logWidget = {
        log: vi.fn(),
        height: 50,
        focus: vi.fn(),
        key: vi.fn(),
        scroll: vi.fn(),
        getScrollHeight: vi.fn().mockReturnValue(100),
        setScrollPerc: vi.fn(),
        childBase: 0,
      }
      blessed.log.mockReturnValue(logWidget)

      const eventBus = createEventBus()
      const ui = createBlessedUI(eventBus, blessed)

      ui.getLogSink().log("New message")

      // Should auto-scroll to bottom (100%)
      expect(logWidget.setScrollPerc).toHaveBeenCalledWith(100)
    })
  })

  describe("interaction", () => {
    it("registers interaction handler on event bus", () => {
      const blessed = createMockBlessed()
      const eventBus = createEventBus()
      createBlessedUI(eventBus, blessed)

      expect(eventBus.setInteractionHandler).toHaveBeenCalled()
    })

    it("resolves with 'continue' when user presses '1' for first action", async () => {
      const blessed = createMockBlessed()
      const screenInstance = blessed.screen()
      const keyListeners: Record<string, Function[]> = {}
      screenInstance.key = vi.fn((keys: string[], handler: Function) => {
        for (const k of keys) {
          if (!keyListeners[k]) keyListeners[k] = []
          keyListeners[k].push(handler)
        }
      })

      const eventBus = createEventBus()
      let registeredHandler: ((req: any) => Promise<any>) | null = null
      eventBus.setInteractionHandler = vi.fn((handler: any) => { registeredHandler = handler })

      createBlessedUI(eventBus, blessed)

      const promise = registeredHandler!({ prompt: "Which?", agent: "implementer", actions: ["continue", "abort"] })

      for (const handler of keyListeners["1"] ?? []) {
        handler()
      }

      await expect(promise).resolves.toEqual({ action: "continue" })
    })

    it("resolves with 'abort' when user presses '2' for second action", async () => {
      const blessed = createMockBlessed()
      const screenInstance = blessed.screen()
      const keyListeners: Record<string, Function[]> = {}
      screenInstance.key = vi.fn((keys: string[], handler: Function) => {
        for (const k of keys) {
          if (!keyListeners[k]) keyListeners[k] = []
          keyListeners[k].push(handler)
        }
      })

      const eventBus = createEventBus()
      let registeredHandler: ((req: any) => Promise<any>) | null = null
      eventBus.setInteractionHandler = vi.fn((handler: any) => { registeredHandler = handler })

      createBlessedUI(eventBus, blessed)

      const promise = registeredHandler!({ prompt: "Which?", agent: "implementer", actions: ["continue", "abort"] })

      for (const handler of keyListeners["2"] ?? []) {
        handler()
      }

      await expect(promise).resolves.toEqual({ action: "abort" })
    })

    it("resolves with predefined action when user presses number key", async () => {
      const blessed = createMockBlessed()
      const screenInstance = blessed.screen()
      const keyListeners: Record<string, Function[]> = {}
      screenInstance.key = vi.fn((keys: string[], handler: Function) => {
        for (const k of keys) {
          if (!keyListeners[k]) keyListeners[k] = []
          keyListeners[k].push(handler)
        }
      })

      const eventBus = createEventBus()
      let registeredHandler: ((req: any) => Promise<any>) | null = null
      eventBus.setInteractionHandler = vi.fn((handler: any) => { registeredHandler = handler })

      createBlessedUI(eventBus, blessed)

      const promise = registeredHandler!({
        prompt: "Choose action",
        agent: "reviewer",
        actions: ["approve", "revise", "retry-review", "abort"],
      })

      // 按 '2' 选择 "revise"
      for (const handler of keyListeners["2"] ?? []) {
        handler()
      }

      await expect(promise).resolves.toEqual({ action: "revise" })
    })

    it("does not resolve when no key is pressed", async () => {
      vi.useRealTimers()

      const blessed = createMockBlessed()
      const screenInstance = blessed.screen()
      const keyListeners: Record<string, Function[]> = {}
      screenInstance.key = vi.fn((keys: string[], handler: Function) => {
        for (const k of keys) {
          if (!keyListeners[k]) keyListeners[k] = []
          keyListeners[k].push(handler)
        }
      })

      const eventBus = createEventBus()
      let registeredHandler: ((req: any) => Promise<any>) | null = null
      eventBus.setInteractionHandler = vi.fn((handler: any) => { registeredHandler = handler })

      createBlessedUI(eventBus, blessed)

      const promise = registeredHandler!({ prompt: "Which?", agent: "implementer" })

      const timeout = new Promise((resolve) => setTimeout(() => resolve("timeout"), 50))
      await expect(Promise.race([promise, timeout])).resolves.toBe("timeout")

      vi.useFakeTimers()
    })
  })

  describe("isInteractiveTTY", () => {
    it("returns true when all streams are TTY", async () => {
      const originalStdout = process.stdout.isTTY
      const originalStdin = process.stdin.isTTY
      const originalStderr = process.stderr.isTTY

      try {
        process.stdout.isTTY = true
        process.stdin.isTTY = true
        process.stderr.isTTY = true

        const { isInteractiveTTY } = await import("./ui.js")
        expect(isInteractiveTTY()).toBe(true)
      } finally {
        process.stdout.isTTY = originalStdout
        process.stdin.isTTY = originalStdin
        process.stderr.isTTY = originalStderr
      }
    })

    it("returns false when stdout is not TTY", async () => {
      const originalStdout = process.stdout.isTTY
      const originalStdin = process.stdin.isTTY
      const originalStderr = process.stderr.isTTY

      try {
        process.stdout.isTTY = false
        process.stdin.isTTY = true
        process.stderr.isTTY = true

        const { isInteractiveTTY } = await import("./ui.js")
        expect(isInteractiveTTY()).toBe(false)
      } finally {
        process.stdout.isTTY = originalStdout
        process.stdin.isTTY = originalStdin
        process.stderr.isTTY = originalStderr
      }
    })

    it("returns false when stdin is not TTY", async () => {
      const originalStdout = process.stdout.isTTY
      const originalStdin = process.stdin.isTTY
      const originalStderr = process.stderr.isTTY

      try {
        process.stdout.isTTY = true
        process.stdin.isTTY = false
        process.stderr.isTTY = true

        const { isInteractiveTTY } = await import("./ui.js")
        expect(isInteractiveTTY()).toBe(false)
      } finally {
        process.stdout.isTTY = originalStdout
        process.stdin.isTTY = originalStdin
        process.stderr.isTTY = originalStderr
      }
    })

    it("returns false when stderr is not TTY", async () => {
      const originalStdout = process.stdout.isTTY
      const originalStdin = process.stdin.isTTY
      const originalStderr = process.stderr.isTTY

      try {
        process.stdout.isTTY = true
        process.stdin.isTTY = true
        process.stderr.isTTY = false

        const { isInteractiveTTY } = await import("./ui.js")
        expect(isInteractiveTTY()).toBe(false)
      } finally {
        process.stdout.isTTY = originalStdout
        process.stdin.isTTY = originalStdin
        process.stderr.isTTY = originalStderr
      }
    })
  })
})
