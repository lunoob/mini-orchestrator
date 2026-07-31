import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  bootstrapSession,
  runAgentIntegration,
  runAgentUpdate,
  sendTask,
  sendTaskAndMonitor,
  startAgentResumed,
  stopAgent,
  waitForAgentWithMonitor,
} from "../agent/index.js"
import { resolveAgentConfig } from "../config/agents.js"
import { isProtocolError, parseOutcome } from "../lib/outcome-parser.js"
import { printSection, stripAgentOutcome } from "../lib/utils.js"
import type { ParsedArgs } from "../types.js"
import type { WorkflowEventBus } from "./events.js"

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const IMPLEMENT_OUTPUT_PARTIAL = path.join(PROJECT_ROOT, "prompts/partials/implement-output.md")

const TEST_PROMPT = `#任务
查询今天佛山天气

## 工作约束

- 若 spec 或需求不清楚，先提问并输出 JSON outcome 标记 \`needs_input\`
- 完成全部实现且通过提交前自审后，输出 JSON outcome 标记 \`completed\`
- 若 review 驳回，根据反馈修改后再次输出 \`completed\` outcome
- 禁止自动执行 git commit 完成代码提交`

export const loadImplementOutputFormat = async () => {
  const template = await readFile(IMPLEMENT_OUTPUT_PARTIAL, "utf8")
  // 不再使用分隔线占位符；直接返回模板内容
  return template
}

export const buildTestStatusPrompt = (outputFormat: string) =>
  `${TEST_PROMPT}\n\n${outputFormat}`

export const runTestStatus = async (args: ParsedArgs, eventBus?: WorkflowEventBus) => {
  const projectDir = args.projectDir ?? process.cwd()
  const agent = resolveAgentConfig({
    agent: "claude",
    model: "default",
    name: "test-claude",
  })

  // 发布初始状态事件
  eventBus?.publish({ type: "issue_change", issueIndex: 0, issueCount: 1, issueTitle: "test-status" })
  eventBus?.publish({ type: "phase_change", phase: "implement" })
  eventBus?.publish({ type: "agent_state_change", agent: "implementer", status: "idle" })

  let paneId: string | undefined
  let started = false
  let primaryError: Error | undefined
  let failPublished = false

  try {
    console.log("[TestStatus] Starting herdr status test with claude agent")
    console.log(`[TestStatus] Project dir: ${projectDir}`)
    console.log(`[TestStatus] Command: ${agent.command}`)

    await Promise.all([
      runAgentUpdate(projectDir, agent),
      runAgentIntegration(agent),
    ])

    // 使用 JSONL-based monitoring 流程
    const sessionHandle = await bootstrapSession(agent)
    paneId = await startAgentResumed(projectDir, agent, sessionHandle.resumeId, {
      ensureUniqueName: true,
    })
    started = true

    eventBus?.publish({ type: "workflow_started", startedAt: Date.now() })
    eventBus?.publish({ type: "agent_state_change", agent: "implementer", status: "working" })

    const outputFormat = await loadImplementOutputFormat()
    const prompt = buildTestStatusPrompt(outputFormat)
    console.log(`[TestStatus] Sending prompt:\n${prompt}`)

    // 循环处理：首次发送 prompt，needs_input 后发送 continuation prompt 继续
    const firstResult = await sendTaskAndMonitor(paneId, prompt, sessionHandle)
    let currentOutput = firstResult.finalText
    let currentMonitorStatus = firstResult.status
    let currentQuestion: string | undefined = firstResult.question

    while (true) {
      // 优先 monitor 状态，再通过 AgentOutcome 判断
      const tempResult = parseOutcome(currentOutput, "implementer")
      const outcomeOutcome = isProtocolError(tempResult) ? "failed" : tempResult.outcome
      const effectiveStatus = currentMonitorStatus === "failed" ? "failed"
        : currentMonitorStatus === "needs_input" ? "needs_input"
        : outcomeOutcome === "completed" ? "done"
        : outcomeOutcome === "needs_input" ? "needs_input"
        : outcomeOutcome === "failed" ? "failed"
        : "unknown"

      console.log(`[TestStatus] Status: ${effectiveStatus} (monitor=${currentMonitorStatus}, outcome=${outcomeOutcome})`)
      printSection("TestStatus Output", stripAgentOutcome(currentOutput))

      if (effectiveStatus === "done") {
        eventBus?.publish({ type: "agent_state_change", agent: "implementer", status: "completed" })
        eventBus?.publish({ type: "complete" })
        failPublished = false
        console.log("[TestStatus] Agent completed idle cycle successfully")
        break
      }

      if (effectiveStatus === "failed") {
        throw new Error("[TestStatus] Agent failed")
      }

      if (effectiveStatus === "needs_input") {
        const reason = currentQuestion ?? "需要确认"
        eventBus?.publish({ type: "agent_state_change", agent: "implementer", status: "needs_input" })
        eventBus?.publish({ type: "needs_input", agent: "implementer", provider: sessionHandle.provider, reason })
        eventBus?.publish({ type: "pause", reason: "implementer needs_input" })

        if (!eventBus) {
          throw new Error("[TestStatus] Agent needs_input (no panel available)")
        }

        // 面板展示问题，收集用户回答
        const result = await eventBus.requestInteraction({
          prompt: `Agent 提问: ${reason}\n请在 pane 中处理后选择继续，或输入回答文本`,
          agent: "implementer",
          actions: ["continue", "abort"],
          textOptional: true,
          textInputPlaceholder: "回答（可选，将发送给 Agent）",
        })

        if (result.action === "abort") {
          throw new Error("[TestStatus] User aborted after needs_input")
        }

        // 用户选择继续：发送回答（若有）+ continuation prompt，继续监控
        eventBus.publish({ type: "agent_state_change", agent: "implementer", status: "working" })
        console.log("[TestStatus] User chose to continue, sending continuation prompt...")

        const userMsg: Record<string, unknown> = { type: "user_response" }
        if (result.text) userMsg.text = result.text
        const continuationText = `${JSON.stringify(userMsg)}\nBased on the user's response above, continue with the previous task. Output the outcome as a JSON object with the required schema.`
        await sendTask(paneId, continuationText)

        const continuation = await waitForAgentWithMonitor(sessionHandle)
        sessionHandle.offset = continuation.finalOffset
        currentOutput = continuation.finalText
        currentMonitorStatus = continuation.status
        currentQuestion = continuation.lastEvent?.question
        continue
      }

      // unknown 状态（既非 done 也非 needs_input/failed）
      throw new Error(`[TestStatus] Unexpected status: ${effectiveStatus}`)
    }
  } catch (error) {
    primaryError = error instanceof Error ? error : new Error(String(error))
    if (!failPublished) {
      eventBus?.publish({ type: "agent_state_change", agent: "implementer", status: "failed" })
      eventBus?.publish({ type: "fail", reason: primaryError.message })
      failPublished = true
    }
    throw error
  } finally {
    // 清理资源；清理失败时附加记录，不覆盖主流程异常
    if (started && paneId) {
      try {
        await stopAgent(paneId)
      } catch (cleanupError) {
        const msg = cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
        console.error(`[TestStatus] Cleanup failed: ${msg}`)
        if (!failPublished) {
          eventBus?.publish({ type: "agent_state_change", agent: "implementer", status: "failed" })
          eventBus?.publish({ type: "fail", reason: `Cleanup failed: ${msg}` })
          failPublished = true
        }
        // 主流程已有异常时不覆盖；主流程成功但清理失败时抛出
        if (!primaryError) {
          throw cleanupError
        }
      }
    }
  }
}
