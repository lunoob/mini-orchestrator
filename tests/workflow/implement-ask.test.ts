import { describe, expect, it, vi } from "vitest"

import {
  ImplementAskAbortError,
  handleSessionImplementOutcome,
  type ImplementAskDeps,
} from "@src/workflow/implement-ask"
import { formatAgentOutcome, type ImplementerOutcome, OutcomeParseError } from "@src/workflow/agent-outcome"
import type { WorkflowAgent } from "@src/session/workflow-agent"
import type { UserDecisionBroker } from "@src/workflow/agent-outcome"

const createMockAgent = (outputs: string[]): WorkflowAgent => {
  let callIndex = 0
  return {
    sessionId: "test-session",
    sendTaskAndWait: vi.fn(async () => {
      if (callIndex >= outputs.length) throw new Error("No more outputs")
      return outputs[callIndex++]
    }),
    lastTurnId: () => undefined,
    stop: vi.fn(),
  }
}

const createMockBroker = (decision: { optionId?: string; text?: string } | null): UserDecisionBroker => ({
  requestDecision: vi.fn(async () => decision),
})

const createDeps = (overrides: Partial<ImplementAskDeps> = {}): ImplementAskDeps => ({
  log: vi.fn(),
  ...overrides,
})

describe("handleSessionImplementOutcome", () => {
  it("returns outcome when completed", async () => {
    const output = formatAgentOutcome({ outcome: "completed", summary: "实现完成" })
    const agent = createMockAgent([])
    const deps = createDeps()

    const result = await handleSessionImplementOutcome(output, "implement", agent, undefined, deps)

    expect(result.outcome).toBe("completed")
    expect(result.summary).toBe("实现完成")
    expect(agent.sendTaskAndWait).not.toHaveBeenCalled()
  })

  it("throws error when failed", async () => {
    const output = formatAgentOutcome({
      outcome: "failed",
      summary: "实现失败",
      failure: { message: "无法找到依赖包" },
    })
    const agent = createMockAgent([])
    const deps = createDeps()

    await expect(
      handleSessionImplementOutcome(output, "implement", agent, undefined, deps),
    ).rejects.toThrow(/无法找到依赖包/)
  })

  it("throws ImplementAskAbortError when needs_input without broker", async () => {
    const output = formatAgentOutcome({
      outcome: "needs_input",
      summary: "需要确认",
      request: { question: "是否继续？", allowFreeform: true },
    })
    const agent = createMockAgent([])
    const deps = createDeps()

    await expect(
      handleSessionImplementOutcome(output, "implement", agent, undefined, deps),
    ).rejects.toBeInstanceOf(ImplementAskAbortError)
  })

  it("uses broker to handle needs_input and continues on user decision", async () => {
    const needsInputOutput = formatAgentOutcome({
      outcome: "needs_input",
      summary: "需要确认",
      request: {
        question: "选择方案",
        options: [
          { id: "a", label: "方案A" },
          { id: "b", label: "方案B" },
        ],
        allowFreeform: false,
      },
    })
    const completedOutput = formatAgentOutcome({ outcome: "completed", summary: "完成" })

    const agent = createMockAgent([needsInputOutput, completedOutput])
    const broker = createMockBroker({ optionId: "a" })
    const deps = createDeps()

    const result = await handleSessionImplementOutcome(needsInputOutput, "implement", agent, broker, deps)

    expect(result.outcome).toBe("completed")
    expect(broker.requestDecision).toHaveBeenCalledWith(
      "test-session",
      "implementer",
      expect.objectContaining({ question: "选择方案" }),
      undefined, // lastTurnId from mock agent
    )
    // 验证用户决策被发送回 agent
    expect(agent.sendTaskAndWait).toHaveBeenCalledWith(
      JSON.stringify({ type: "user_decision", optionId: "a", text: undefined }),
    )
  })

  it("throws ImplementAskAbortError when broker returns null", async () => {
    const output = formatAgentOutcome({
      outcome: "needs_input",
      summary: "需要确认",
      request: { question: "是否继续？", allowFreeform: true },
    })
    const agent = createMockAgent([])
    const broker = createMockBroker(null)
    const deps = createDeps()

    await expect(
      handleSessionImplementOutcome(output, "implement", agent, broker, deps),
    ).rejects.toBeInstanceOf(ImplementAskAbortError)
  })

  it("sends retry message on invalid JSON and succeeds on retry", async () => {
    const invalidOutput = "这不是 JSON"
    const validOutput = formatAgentOutcome({ outcome: "completed", summary: "完成" })

    // 第一次解析失败后，agent 会发送修正消息，然后返回有效输出
    const agent = createMockAgent([validOutput])
    const deps = createDeps()

    const result = await handleSessionImplementOutcome(invalidOutput, "implement", agent, undefined, deps)

    expect(result.outcome).toBe("completed")
    expect(agent.sendTaskAndWait).toHaveBeenCalledTimes(1)
    expect(agent.sendTaskAndWait).toHaveBeenCalledWith(
      expect.stringContaining("JSON outcome 规范"),
    )
  })

  it("sends retry message on empty output and succeeds on retry", async () => {
    const emptyOutput = ""
    const validOutput = formatAgentOutcome({ outcome: "completed", summary: "完成" })

    // 空输出也会触发重试
    const agent = createMockAgent([validOutput])
    const deps = createDeps()

    const result = await handleSessionImplementOutcome(emptyOutput, "implement", agent, undefined, deps)

    expect(result.outcome).toBe("completed")
    expect(agent.sendTaskAndWait).toHaveBeenCalledTimes(1)
    expect(agent.sendTaskAndWait).toHaveBeenCalledWith(
      expect.stringContaining("JSON outcome 规范"),
    )
  })

  it("throws error when retry also fails", async () => {
    const invalidOutput = "仍然不是 JSON"
    const invalidRetryOutput = "还是不对"

    // 第一次解析失败，发送修正消息后第二次解析也失败
    const agent = createMockAgent([invalidRetryOutput])
    const deps = createDeps()

    await expect(
      handleSessionImplementOutcome(invalidOutput, "implement", agent, undefined, deps),
    ).rejects.toThrow(/两次输出均不符合/)
  })

  it("handles recursive needs_input", async () => {
    const needsInput1 = formatAgentOutcome({
      outcome: "needs_input",
      summary: "第一个问题",
      request: { question: "问题1？", allowFreeform: true },
    })
    const needsInput2 = formatAgentOutcome({
      outcome: "needs_input",
      summary: "第二个问题",
      request: { question: "问题2？", allowFreeform: true },
    })
    const completed = formatAgentOutcome({ outcome: "completed", summary: "完成" })

    // 第一次 needs_input 后发送用户决策，返回 needsInput2
    // 第二次 needs_input 后发送用户决策，返回 completed
    const agent = createMockAgent([needsInput2, completed])
    const broker = createMockBroker({ text: "回答" })
    const deps = createDeps()

    const result = await handleSessionImplementOutcome(needsInput1, "implement", agent, broker, deps)

    expect(result.outcome).toBe("completed")
    expect(broker.requestDecision).toHaveBeenCalledTimes(2)
    expect(agent.sendTaskAndWait).toHaveBeenCalledTimes(2)
  })
})
