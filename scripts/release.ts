import { execFileSync } from "node:child_process"
import { createInterface } from "node:readline"

import { ensureMainBranch, finalizeGitRelease } from "../src/release/git-utils.js"
import { loadReleaseEnv } from "../src/release/load-env.js"
import { getLatestPublishedVersion } from "../src/release/npm-utils.js"
import { executable, runCommandOrThrow } from "../src/release/run-command.js"
import { isPrerelease, nextProductionVersion, nextStagingVersion } from "../src/release/version-plan.js"
import { readPackageJson, readVersion } from "../src/release/version.js"
import { executeRelease } from "../src/release/workflow.js"

const increments = ["patch", "minor", "major"] as const
const releaseTypes = ["staging", "production"] as const

type ReleaseType = (typeof releaseTypes)[number]

type Prompt = {
  question: (query: string) => Promise<string>
  close: () => void
}

// 不用 readline 的 question:它在管道输入(预缓冲 + EOF)下第二个提问会挂起。
// 这里自行收集 line 事件到队列,question 优先消费已缓冲的行。
const createPrompt = (): Prompt => {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const queue: string[] = []
  let waiting: ((line: string) => void) | null = null

  rl.on("line", line => {
    if (waiting) {
      const resolve = waiting
      waiting = null
      resolve(line)
    } else {
      queue.push(line)
    }
  })

  return {
    question: query => {
      process.stdout.write(query)
      const buffered = queue.shift()
      if (buffered !== undefined) return Promise.resolve(buffered)
      return new Promise<string>(resolve => {
        waiting = resolve
      })
    },
    close: () => rl.close(),
  }
}

const getReleaseType = async (input: Prompt): Promise<ReleaseType> => {
  const argument = process.argv.slice(2).find(value => value !== "--")
  if (argument) {
    if (releaseTypes.includes(argument as ReleaseType)) return argument as ReleaseType
    if (increments.includes(argument as (typeof increments)[number])) return "production"
    throw new Error("Release type must be staging or production; increment must be patch, minor, or major.")
  }

  console.log("-> staging")
  console.log("-> production")
  const answer = await input.question("-> ")

  const type = answer.trim()
  if (!releaseTypes.includes(type as ReleaseType)) {
    throw new Error("Release type must be staging or production.")
  }
  return type as ReleaseType
}

const getIncrement = async (input: Prompt) => {
  const answer = await input.question("Version increment (patch/minor/major) [patch]: ")
  const increment = answer.trim() || "patch"
  if (!increments.includes(increment as (typeof increments)[number])) {
    throw new Error("Version increment must be patch, minor, or major.")
  }
  return increment as (typeof increments)[number]
}

const ensureReady = () => {
  ensureMainBranch()

  const status = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()
  if (status) throw new Error("Release requires a clean working tree.")
}

const resolveProductionBase = (): string => {
  const { name } = readPackageJson()
  const latest = getLatestPublishedVersion(name)
  if (latest) return latest

  const local = readVersion()
  if (isPrerelease(local)) {
    throw new Error(
      "Cannot read the latest published version from npm, and the local version is a prerelease. " +
        "Fix package.json or check the npm registry before publishing a production release.",
    )
  }

  console.log(`npm registry unreachable, falling back to local version ${local}.`)
  return local
}

const releaseStaging = async (version: string) => {
  await executeRelease({
    prepare: async () => {
      await runCommandOrThrow(executable("npm"), ["version", version, "--no-git-tag-version"])
      return readVersion()
    },
    publish: async () => {},
    finalizeGit: async version => {
      finalizeGitRelease(version)
    },
    releaseGithub: version =>
      runCommandOrThrow(executable("pnpm"), ["run", "release:github", "--", version]),
  })
}

const releaseProduction = async (increment: (typeof increments)[number]) => {
  await executeRelease({
    prepare: async () => {
      const base = resolveProductionBase()
      const next = nextProductionVersion(base, increment)
      await runCommandOrThrow(executable("npm"), ["version", next, "--no-git-tag-version"])
      return readVersion()
    },
    publish: () => runCommandOrThrow(executable("pnpm"), ["publish"]),
    finalizeGit: () => runCommandOrThrow(executable("pnpm"), ["run", "release:git"]),
    releaseGithub: () => runCommandOrThrow(executable("pnpm"), ["run", "release:github"]),
  })
}

const main = async () => {
  loadReleaseEnv()
  ensureReady()

  const input = createPrompt()
  const type = await getReleaseType(input)

  if (type === "staging") {
    const version = nextStagingVersion(readVersion())
    console.log(`Staging version: ${version}`)
    const answer = await input.question("Confirm release (y/N): ")
    input.close()

    if (!/^y/i.test(answer.trim())) {
      console.log("Aborted.")
      return
    }
    await releaseStaging(version)
    return
  }

  const increment = await getIncrement(input)
  input.close()

  await releaseProduction(increment)
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
