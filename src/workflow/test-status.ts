import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  agentWaitOptions,
  bootstrapSession,
  runAgentIntegration,
  runAgentUpdate,
  sendTaskAndMonitor,
  startAgentResumed,
  stopAgent,
  waitForAgentReady,
} from "../agent/index.js"
import { resolveAgentConfig } from "../config/agents.js"
import {
  parseImplementStatus,
  printSection,
  stripStatusLines,
} from "../lib/utils.js"
import type { ParsedArgs } from "../types.js"

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const IMPLEMENT_OUTPUT_PARTIAL = path.join(PROJECT_ROOT, "prompts/partials/implement-output.md")

const TEST_PROMPT = `#任务
查询今天佛山天气

## 工作约束

- 若 spec 或需求不清楚，先提问并输出 \`STATUS: IMPLEMENT_ASK\`，不要猜测
- 完成全部实现且通过提交前自审后，输出 \`STATUS: IMPLEMENT_DONE\`
- 若 review 驳回，根据反馈修改后再次输出 \`STATUS: IMPLEMENT_DONE\`
- 禁止自动执行 git commit 完成代码提交`

export const loadImplementOutputFormat = async () => {
  const template = await readFile(IMPLEMENT_OUTPUT_PARTIAL, "utf8")
  // 不再使用分隔线占位符；直接返回模板内容
  return template
}

export const buildTestStatusPrompt = (outputFormat: string) =>
  `${TEST_PROMPT}\n\n${outputFormat}`

export const runTestStatus = async (args: ParsedArgs) => {
  const projectDir = args.projectDir ?? process.cwd()
  const agent = resolveAgentConfig({
    agent: "claude",
    model: "default",
    name: "test-claude",
  })

  console.log("[TestStatus] Starting herdr status test with claude agent")
  console.log(`[TestStatus] Project dir: ${projectDir}`)
  console.log(`[TestStatus] Command: ${agent.command}`)

  await Promise.all([
    runAgentUpdate(projectDir, agent),
    runAgentIntegration(agent),
  ])

  // 使用 JSONL-based monitoring 流程
  const sessionHandle = await bootstrapSession(agent)
  const paneId = await startAgentResumed(projectDir, agent, sessionHandle.resumeId, {
    ensureUniqueName: true,
  })
  let started = false

  try {
    started = true
    await waitForAgentReady(paneId, agentWaitOptions(agent))

    const outputFormat = await loadImplementOutputFormat()
    const prompt = buildTestStatusPrompt(outputFormat)
    console.log(`[TestStatus] Sending prompt:\n${prompt}`)

    const { finalText } = await sendTaskAndMonitor(paneId, prompt, sessionHandle)
    const status = parseImplementStatus(finalText)

    console.log(`[TestStatus] Status: ${status}`)
    printSection("TestStatus Output", stripStatusLines(finalText))
    console.log("[TestStatus] Agent completed idle cycle successfully")
  } finally {
    if (started) await stopAgent(paneId)
  }
}
