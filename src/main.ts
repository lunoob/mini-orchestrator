import { NeedsCheckPauseError } from "./needs-check.js"
import { assertHerdrEnv, getErrorMessage } from "./utils.js"
import { getConfigPath, parseArgs, printHelp, wantsHelp } from "./cli.js"
import { runWorkflow } from "./workflow.js"

export const main = async () => {
  const argv = process.argv.slice(2)

  if (wantsHelp(argv)) {
    printHelp()
    return
  }

  assertHerdrEnv()

  const args = parseArgs(argv)
  if (args.config) {
    args.config = getConfigPath(args)
  } else if (!args["resume-from"]) {
    throw new Error("Missing required argument --config /absolute/path/to/workflow.json")
  }

  await runWorkflow(args)
}

void main().catch((error) => {
  if (error instanceof NeedsCheckPauseError) {
    process.exitCode = 2
    return
  }

  console.error(`\nWorkflow failed: ${getErrorMessage(error)}`)
  process.exitCode = 1
})
