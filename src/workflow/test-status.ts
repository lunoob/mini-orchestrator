import path from "node:path"

import { resolveAgentConfig } from "../config/agents.js"
import { createSessionApiServer } from "../session/server.js"
import { createSessionClient } from "../session/client.js"
import { startWorkflowAgent } from "../session/workflow-agent.js"
import { parseAgentOutcome, type AgentOutcome } from "./agent-outcome.js"
import type { ParsedArgs } from "../types.js"

const TEST_PROMPT = `#任务
查询今天佛山天气

## 工作约束

- 完成任务后输出纯 JSON 对象

## 输出要求

完成任务后，你必须输出一个**纯 JSON 对象**作为最终回复，不得包含任何说明文字、Markdown code fence 或 STATUS 标记。

JSON 格式：
\`\`\`json
{
  "outcome": "completed",
  "summary": "简述完成的工作"
}
\`\`\`

或需要用户输入时：
\`\`\`json
{
  "outcome": "needs_input",
  "summary": "需要确认",
  "request": {
    "question": "要问的问题",
    "allowFreeform": true
  }
}
\`\`\`

或失败时：
\`\`\`json
{
  "outcome": "failed",
  "summary": "失败原因",
  "failure": { "message": "详细错误" }
}
\`\`\``

export const runTestStatus = async (args: ParsedArgs) => {
  const projectDir = args.projectDir ?? process.cwd()
  const runDirectory = path.join(projectDir, ".orchestrator")

  const agent = resolveAgentConfig({
    agent: "claude",
    model: "default",
    name: "test-claude",
  })

  console.log("[TestStatus] Starting agent status test with claude agent")
  console.log(`[TestStatus] Project dir: ${projectDir}`)
  console.log(`[TestStatus] Command: ${agent.command}`)

  const sessionServer = createSessionApiServer({ runDirectory })
  const { baseUrl, token } = await sessionServer.start()
  const sessionClient = createSessionClient({ baseUrl, token })

  let agent_: Awaited<ReturnType<typeof startWorkflowAgent>> | undefined

  try {
    agent_ = await startWorkflowAgent({
      agent,
      baseUrl,
      client: sessionClient,
      projectDir,
      role: "implementer",
      runDirectory,
    })

    const prompt = TEST_PROMPT
    console.log(`[TestStatus] Sending prompt:\n${prompt}`)

    const rawOutput = await agent_.sendTaskAndWait(prompt)
    let outcome: AgentOutcome

    try {
      outcome = parseAgentOutcome(rawOutput, "implementer")
    } catch (parseError) {
      console.log(`[TestStatus] First parse failed, asking agent to retry...`)
      const retryOutput = await agent_.sendTaskAndWait(
        "你的输出不符合 JSON outcome 规范。请严格按照 schema 输出纯 JSON 对象。"
      )
      outcome = parseAgentOutcome(retryOutput, "implementer")
    }

    console.log(`[TestStatus] Outcome: ${outcome.outcome}`)
    console.log(`[TestStatus] Summary: ${outcome.summary}`)
    if (outcome.request) {
      console.log(`[TestStatus] Request: ${outcome.request.question}`)
    }
    if (outcome.failure) {
      console.log(`[TestStatus] Failure: ${outcome.failure.message}`)
    }
    console.log("[TestStatus] Agent completed via Session API successfully")
  } finally {
    if (agent_) await agent_.stop()
    await sessionServer.stop()
  }
}
