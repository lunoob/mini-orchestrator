import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { createInterface } from "node:readline/promises"

import { loadReleaseEnv } from "../src/release/load-env.js"
import { executable, runCommandOrThrow } from "../src/release/run-command.js"
import { executeRelease } from "../src/release/workflow.js"

const increments = ["patch", "minor", "major"] as const

const getIncrement = async () => {
  const argument = process.argv.slice(2).find(value => value !== "--")
  if (argument) {
    if (increments.includes(argument as (typeof increments)[number])) return argument
    throw new Error("Version increment must be patch, minor, or major.")
  }

  const input = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await input.question("Version increment (patch/minor/major) [patch]: ")
  input.close()

  const increment = answer.trim() || "patch"
  if (!increments.includes(increment as (typeof increments)[number])) {
    throw new Error("Version increment must be patch, minor, or major.")
  }
  return increment
}

const ensureReady = () => {
  const branch = execFileSync("git", ["branch", "--show-current"], { encoding: "utf8" }).trim()
  if (branch !== "main") throw new Error("Release must run on the main branch.")

  const status = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()
  if (status) throw new Error("Release requires a clean working tree.")
}

const readVersion = () => {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as { version?: unknown }
  if (typeof packageJson.version !== "string") throw new Error("package.json version is missing.")
  return packageJson.version
}

const main = async () => {
  loadReleaseEnv()
  ensureReady()
  const increment = await getIncrement()

  await executeRelease({
    prepare: async () => {
      await runCommandOrThrow(executable("npm"), ["version", increment, "--no-git-tag-version"])
      return readVersion()
    },
    publish: () => runCommandOrThrow(executable("pnpm"), ["publish"]),
    finalizeGit: () => runCommandOrThrow(executable("pnpm"), ["run", "release:git"]),
    releaseGithub: () => runCommandOrThrow(executable("pnpm"), ["run", "release:github"]),
  })
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
