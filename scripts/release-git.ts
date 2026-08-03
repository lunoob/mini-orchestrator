import { executable, runCommandOrThrow } from "../src/release/run-command.js"

const main = async () => {
  await runCommandOrThrow(executable("release-it"), [
    "--no-increment",
    "--no-npm.publish",
    "--no-github.release",
    "--no-git.requireCleanWorkingDir",
    "--ci",
  ])
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
