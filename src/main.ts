import { format } from "node:util"

import { notifyError, notifySuccess, notifyTestStatusComplete } from "./notify/index.js"
import { assertHerdrEnv, getErrorMessage } from "./lib/utils.js"
import { getConfigPath, parseArgs, printHelp, wantsHelp } from "./cli/index.js"
import { runSkillCli } from "./cli/skill.js"
import { AgentFailError, ImplementAskAbortError } from "./workflow/implement-ask.js"
import { runWorkflow } from "./workflow/index.js"
import { runTestStatus } from "./workflow/test-status.js"
import { createWorkflowEventBus } from "./workflow/events.js"
import { createTerminalUI, isInteractiveTTY, type LogSink } from "./terminal/ui.js"

/**
 * 将 console.log/warn/error 代理到 LogSink。
 *
 * - 使用 util.format 保留 console 的格式化行为（%s, %d, 对象展开等）
 * - log 写入 stdout sink，warn/error 写入 stderr sink
 * - 返回恢复函数
 */
const proxyConsoleToSink = (sink: LogSink): (() => void) => {
  const originalLog = console.log
  const originalWarn = console.warn
  const originalError = console.error

  console.log = (...args: any[]) => { sink.log(format(...args)) }
  console.warn = (...args: any[]) => { sink.logStderr(format(...args)) }
  console.error = (...args: any[]) => { sink.logStderr(format(...args)) }

  return () => {
    console.log = originalLog
    console.warn = originalWarn
    console.error = originalError
  }
}

export const main = async () => {
  const commandStartedAt = Date.now()
  const argv = process.argv.slice(2)

  if (argv[0] === "skill") {
    process.exitCode = await runSkillCli(argv.slice(1))
    return
  }

  if (wantsHelp(argv)) {
    printHelp()
    return
  }

  assertHerdrEnv()

  const args = parseArgs(argv)

  if (args.config) {
    args.config = getConfigPath(args)
  } else if (args.testStatus !== "true") {
    throw new Error("[Config] Missing required argument --config /absolute/path/to/workflow.json")
  }

  // 创建共享事件总线和 terminal UI
  const useBlessedUI = isInteractiveTTY()
  const eventBus = createWorkflowEventBus(commandStartedAt)
  const ui = useBlessedUI
    ? await createTerminalUI(eventBus)
    : (await import("./terminal/ui.js")).createPlainTextUI(eventBus)
  const logSink = ui.getLogSink()

  try {
    let restoreConsole: (() => void) | undefined
    if (isInteractiveTTY()) {
      restoreConsole = proxyConsoleToSink(logSink)
    }

    try {
      if (args.testStatus === "true") {
        await runTestStatus(args, eventBus)
        notifyTestStatusComplete()
      } else {
        await runWorkflow(args, { eventBus })
        notifySuccess()
      }
    } finally {
      restoreConsole?.()
    }
  } finally {
    ui.stopTimer()
    ui.teardown()
  }
}

void main().catch((error) => {
  // Agent 失败：workflow 失败，返回退出码 1 并发送错误通知
  if (error instanceof AgentFailError) {
    console.error(`\n[Workflow] ${error.message}`)
    notifyError(error.message)
    process.exitCode = 1
    return
  }

  // IMPLEMENT_ASK 时用户选 no：正常中止，不当作工作流失败
  if (error instanceof ImplementAskAbortError) {
    console.log(`\n[Workflow] ${error.message}`)
    process.exitCode = 0
    return
  }

  const message = getErrorMessage(error)
  console.error(`\n[Workflow] Workflow failed: ${message}`)
  notifyError(message)
  process.exitCode = 1
})
