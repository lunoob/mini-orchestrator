import { parseAgentOutcome, type AgentRole, type UserDecisionBroker, OutcomeParseError } from "./agent-outcome.js"
import type { WorkflowAgent } from "../session/workflow-agent.js"

/** 用户在 needs_input 交互中选择取消：正常中止，非故障 */
export class ImplementAskAbortError extends Error {
  constructor(context: string) {
    super(`用户取消继续（${context}）`)
    this.name = "ImplementAskAbortError"
  }
}

export type ImplementAskDeps = {
  log: (message: string) => void
}

export const defaultImplementAskDeps = (): ImplementAskDeps => ({
  log: (message) => console.log(message),
})

/**
 * 处理 implementer 的 outcome JSON。
 * 若 outcome 为 needs_input → 通过 broker 获取用户决策，然后在同一 session 中继续。
 * 若 outcome 为 failed → 抛出错误。
 * 若 outcome 为 completed → 返回 outcome。
 *
 * 格式错误时，发送一次修正消息要求 agent 按 schema 重发；
 * 第二次仍无效则失败。
 */
export const handleSessionImplementOutcome = async (
  output: string,
  context: string,
  agent: WorkflowAgent,
  broker: UserDecisionBroker | undefined,
  deps: ImplementAskDeps = defaultImplementAskDeps(),
): Promise<ReturnType<typeof parseAgentOutcome>> => {
  let outcome = tryParseOutcome(output, "implementer")

  // 第一次解析失败（包括空输出）：发送修正消息
  if (!outcome) {
    deps.log(`[Implement] ${context}: 输出格式不符合 JSON outcome 规范，要求 agent 重发`)
    const retryOutput = await agent.sendTaskAndWait(
      "你的上一轮输出不符合 JSON outcome 规范。请严格按照 schema 输出纯 JSON 对象，不要包含任何说明文字或 Markdown code fence。"
    )
    outcome = tryParseOutcome(retryOutput, "implementer")

    if (!outcome) {
      throw new Error(
        `[Implement] ${context}: agent 两次输出均不符合 JSON outcome 规范。原始输出: ${output.slice(0, 200)}`,
      )
    }
  }

  // 处理 needs_input
  if (outcome.outcome === "needs_input") {
    if (!broker) {
      throw new ImplementAskAbortError(context)
    }

    deps.log(`[Implement] ${context}: agent 需要用户输入`)
    const decision = await broker.requestDecision(agent.sessionId, "implementer", outcome.request!, agent.lastTurnId())

    if (!decision) {
      throw new ImplementAskAbortError(context)
    }

    // 将用户决策作为下一条消息发送回同一个 agent session
    const userMessage = JSON.stringify({
      type: "user_decision",
      optionId: decision.optionId,
      text: decision.text,
    })
    const continueOutput = await agent.sendTaskAndWait(userMessage)

    // 递归处理（可能再次 needs_input）
    return handleSessionImplementOutcome(continueOutput, context, agent, broker, deps)
  }

  // 处理 failed
  if (outcome.outcome === "failed") {
    throw new Error(
      `[Implement] ${context}: agent 报告失败: ${outcome.failure?.message ?? outcome.summary}`,
    )
  }

  // completed
  return outcome
}

const tryParseOutcome = (output: string, role: AgentRole) => {
  try {
    return parseAgentOutcome(output, role)
  } catch (e) {
    if (e instanceof OutcomeParseError) return null
    throw e
  }
}

