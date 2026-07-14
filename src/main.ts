import { NeedsCheckPauseError } from "./needs-check.js"
import { notifyError, notifyNeedsCheck, notifySuccess } from "./notify.js"
import { assertHerdrEnv, getErrorMessage } from "./utils.js"
import { getConfigPath, parseArgs, printHelp, wantsHelp } from "./cli.js"
import { handleReportTaskCli } from "./task-status.js"
import { runWorkflow } from "./workflow.js"

export const main = async () => {
  const argv = process.argv.slice(2)

  // 内部子命令：agent 回报任务状态，不经过 workflow
  if (argv[0] === "report-task") {
    await handleReportTaskCli(argv)
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
  } else if (!args["resume-from"]) {
    throw new Error("[Config] Missing required argument --config /absolute/path/to/workflow.json")
  }

  await runWorkflow(args)
  notifySuccess()
}

void main().catch((error) => {
  if (error instanceof NeedsCheckPauseError) {
    notifyNeedsCheck(error.checkpointPath)
    process.exitCode = 2
    return
  }

  const message = getErrorMessage(error)
  console.error(`\n[Workflow] Workflow failed: ${message}`)
  notifyError(message)
  process.exitCode = 1
})
