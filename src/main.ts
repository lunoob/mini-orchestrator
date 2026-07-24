import { NeedsCheckPauseError } from "./review/needs-check.js"
import { notifyError, notifyNeedsCheck, notifySuccess, notifyTestStatusComplete } from "./notify/index.js"
import { assertHerdrEnv, getErrorMessage } from "./lib/utils.js"
import { getConfigPath, parseArgs, printHelp, wantsHelp } from "./cli/index.js"
import { runSkillCli } from "./cli/skill.js"
import { ImplementAskAbortError } from "./workflow/implement-ask.js"
import { runWorkflow } from "./workflow/index.js"
import { runTestStatus } from "./workflow/test-status.js"

export const main = async () => {
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

  if (args.testStatus === "true") {
    await runTestStatus(args)
    notifyTestStatusComplete()
    return
  }

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
