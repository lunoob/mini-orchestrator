import path from "node:path"

import { resolveAgentConfig } from "../config/agents.js"
import { createSessionApiServer } from "../session/server.js"
import { createSessionClient } from "../session/client.js"
import { startWorkflowAgent } from "../session/workflow-agent.js"
import {
  IMPLEMENT_RESULT_END,
  IMPLEMENT_RESULT_START,
} from "../lib/prompt-delimiters.js"
import {
  extractImplementResult,
  parseImplementStatus,
  printSection,
  stripStatusLines,
} from "../lib/utils.js"
import type { ParsedArgs } from "../types.js"

const TEST_PROMPT = `#任务
查询今天佛山天气

## 工作约束

- 若 spec 或需求不清楚，先提问并输出 \`STATUS: IMPLEMENT_ASK\`，不要猜测
- 完成全部实现且通过提交前自审后，输出 \`STATUS: IMPLEMENT_DONE\`
- 若 review 驳回，根据反馈修改后再次输出 \`STATUS: IMPLEMENT_DONE\`
- 禁止自动执行 git commit 完成代码提交`

export const buildTestStatusPrompt = (outputFormat: string) =>
  `${TEST_PROMPT}\n\n${outputFormat}`

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

    const outputFormat = [
      "## 输出",
      "必须严格遵循以下步骤:",
      `1. 先输出起始前缀: ${IMPLEMENT_RESULT_START}`,
      "2. 再输出其他内容（含 STATUS 标记）",
      `3. 最后输出结束后缀: ${IMPLEMENT_RESULT_END}`,
    ].join("\n")
    const prompt = buildTestStatusPrompt(outputFormat)
    console.log(`[TestStatus] Sending prompt:\n${prompt}`)

    const rawOutput = await agent_.sendTaskAndWait(prompt)
    const resultBody = extractImplementResult(rawOutput)
    const status = parseImplementStatus(resultBody)

    console.log(`[TestStatus] Status: ${status}`)
    printSection("TestStatus Output", stripStatusLines(resultBody))
    console.log("[TestStatus] Agent completed via Session API successfully")
  } finally {
    if (agent_) await agent_.stop()
    await sessionServer.stop()
  }
}
