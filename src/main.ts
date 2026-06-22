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
  args.config = getConfigPath(args)

  await runWorkflow(args)
}

void main().catch((error) => {
  console.error(`\nWorkflow failed: ${getErrorMessage(error)}`)
  process.exitCode = 1
})
