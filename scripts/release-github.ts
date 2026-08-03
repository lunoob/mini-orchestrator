import { ensureMainBranch, ensureRemoteTagExists } from "../src/release/git-utils.js"
import { runGithubRelease } from "../src/release/github-release.js"
import { loadReleaseEnv } from "../src/release/load-env.js"
import { executable, runCommandOrThrow } from "../src/release/run-command.js"
import { readVersion, resolveReleaseVersion } from "../src/release/version.js"
import { executeReleaseGithub } from "../src/release/release-github-workflow.js"

const main = async () => {
  await executeReleaseGithub({
    argv: process.argv,
    loadEnv: () => {
      loadReleaseEnv()
    },
    ensureMainBranch,
    resolveVersion: resolveReleaseVersion,
    ensureRemoteTagExists,
    readVersion,
    runGithubRelease,
    runReleaseIt: () =>
      runCommandOrThrow(executable("release-it"), [
        "--no-increment",
        "--no-npm.publish",
        "--no-git",
        "--github.update",
        "--ci",
      ]),
  })
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
