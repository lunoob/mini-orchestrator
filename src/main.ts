import { format } from "node:util"
import { pathToFileURL } from "node:url"

import { notifyError, notifySuccess, notifyTestStatusComplete } from "./notify/index.js"
import { assertHerdrEnv, getErrorMessage } from "./lib/utils.js"
import { formatCommandDuration } from "./lib/command-duration.js"
import { registerNonInteractiveSignalHandlers } from "./lib/command-signals.js"
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

export const main = async (testStatusMode = false, argv = process.argv.slice(2)) => {

  if (argv[0] === "skill") {
    process.exitCode = await runSkillCli(argv.slice(1))
    return
  }

  if (wantsHelp(argv)) {
    printHelp()
    return
  }

  const commandStartedAt = Date.now()
  // 在 process.exit 阶段输出，确保正常、异常和信号退出时都位于 UI 日志之后。
  process.once("exit", () => {
    process.stdout.write(`${formatCommandDuration(Date.now() - commandStartedAt)}\n`)
  })
  const useBlessedUI = isInteractiveTTY()
  const removeSignalHandlers = useBlessedUI
    ? undefined
    : registerNonInteractiveSignalHandlers(process)

  assertHerdrEnv()

  const args = parseArgs(argv)

  if (!testStatusMode) {
    if (args.config) {
      args.config = getConfigPath(args)
    } else {
      throw new Error("[Config] Missing required argument --config /absolute/path/to/workflow.json")
    }
  }

  // 创建共享事件总线和 terminal UI
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
      if (testStatusMode) {
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
    removeSignalHandlers?.()
    ui.stopTimer()
    ui.teardown()
  }
}

export const handleMainError = (error: unknown) => {
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
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(handleMainError)
}
