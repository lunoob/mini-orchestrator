import { ensureMainBranch, finalizeGitRelease } from "../src/release/git-utils.js"
import { ensureNpmVersionPublished } from "../src/release/npm-utils.js"
import { readPackageJson, resolveReleaseVersion } from "../src/release/version.js"

const main = async () => {
  ensureMainBranch()
  const version = resolveReleaseVersion(process.argv)
  const { name } = readPackageJson()
  ensureNpmVersionPublished(name, version)
  finalizeGitRelease(version)
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
