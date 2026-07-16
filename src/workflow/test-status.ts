import {
  agentWaitOptions,
  runAgentIntegration,
  runAgentUpdate,
  sendTaskAndWait,
  startAgent,
  stopAgent,
  waitForAgentReady,
} from "../agent/index.js"
import { resolveAgentConfig } from "../config/agents.js"
import { printSection } from "../lib/utils.js"
import type { ParsedArgs } from "../types.js"

const TEST_PROMPT = "查询今天佛山天气"

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

  const paneId = await startAgent(projectDir, agent, { ensureUniqueName: true })
  let started = false

  try {
    started = true
    await waitForAgentReady(paneId, agentWaitOptions(agent))

    console.log(`[TestStatus] Sending prompt: ${TEST_PROMPT}`)
    const output = await sendTaskAndWait(paneId, TEST_PROMPT, agentWaitOptions(agent))
    printSection("TestStatus Output", output)
    console.log("[TestStatus] Agent completed idle cycle successfully")
  } finally {
    if (started) await stopAgent(paneId)
  }
}
