import { loadReleaseEnv } from "../src/release/load-env.js"
import { executable, runCommandOrThrow } from "../src/release/run-command.js"

const main = async () => {
  loadReleaseEnv()
  await runCommandOrThrow(executable("release-it"), ["--no-increment", "--no-npm.publish", "--no-git", "--ci"])
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
