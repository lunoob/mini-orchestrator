import { readFileSync } from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"

import { tagName, VERSION_FILES } from "./version.js"
import {
  assertPackageJsonOnlyVersionChanged,
  assertPackageLockOnlyVersionChanged,
} from "./version-files.js"

const gitOutput = (args: string[], cwd = process.cwd()) => {
  const output = execFileSync("git", args, { cwd, encoding: "utf8" })
  return output.endsWith("\n") ? output.slice(0, -1) : output
}

const gitInherit = (args: string[], cwd = process.cwd()) => {
  execFileSync("git", args, { cwd, stdio: "inherit" })
}

const readJsonAtRef = (ref: string, file: string, cwd = process.cwd()) =>
  JSON.parse(gitOutput(["show", `${ref}:${file}`], cwd)) as Record<string, unknown>

const readJsonFromWorktree = (file: string, cwd = process.cwd()) =>
  JSON.parse(readFileSync(path.join(cwd, file), "utf8")) as Record<string, unknown>

export const ensureMainBranch = (cwd = process.cwd()) => {
  const branch = gitOutput(["branch", "--show-current"], cwd)
  if (branch !== "main") throw new Error("Release must run on the main branch.")
}

export const parseChangedTrackedFiles = (status: string) =>
  status
    .split("\n")
    .filter(Boolean)
    .flatMap(line => {
      if (line.startsWith("??")) return []
      const renameMatch = line.match(/ -> (.+)$/)
      if (renameMatch) return [renameMatch[1]!]
      return [line.slice(2).trimStart()]
    })

export const getChangedTrackedFiles = (cwd = process.cwd()) =>
  parseChangedTrackedFiles(gitOutput(["status", "--porcelain"], cwd))

export const ensureOnlyVersionFilesChanged = (cwd = process.cwd()) => {
  const changed = getChangedTrackedFiles(cwd)
  const allowed = new Set<string>(VERSION_FILES)
  const invalid = changed.filter(file => !allowed.has(file))

  if (invalid.length > 0) {
    throw new Error(
      `Release git step only allows changes to version files (${VERSION_FILES.join(", ")}). ` +
        `Unexpected changes: ${invalid.join(", ")}`,
    )
  }

  if (changed.length === 0) {
    throw new Error("No version file changes to commit.")
  }

  if (changed.includes("package.json")) {
    assertPackageJsonOnlyVersionChanged(readJsonAtRef("HEAD", "package.json", cwd), readJsonFromWorktree("package.json", cwd))
  }

  if (changed.includes("package-lock.json")) {
    assertPackageLockOnlyVersionChanged(
      readJsonAtRef("HEAD", "package-lock.json", cwd),
      readJsonFromWorktree("package-lock.json", cwd),
    )
  }
}

const readVersionAtCommit = (commit: string, cwd = process.cwd()) => {
  const packageJson = gitOutput(["show", `${commit}:package.json`], cwd)
  const { version } = JSON.parse(packageJson) as { version?: unknown }
  if (typeof version !== "string") throw new Error(`Commit ${commit} is missing package.json version.`)
  return version
}

export const resolveRemoteTagCommit = (tag: string, cwd = process.cwd()) => {
  const remote = gitOutput(["ls-remote", "--tags", "origin", `refs/tags/${tag}*`], cwd)
  if (!remote) return null

  const lines = remote.split("\n").filter(Boolean)
  const peeledRef = `refs/tags/${tag}^{}`
  const peeledLine = lines.find(line => line.endsWith(peeledRef))
  if (peeledLine) return peeledLine.split("\t")[0] ?? null

  const tagRef = `refs/tags/${tag}`
  const tagLine = lines.find(line => line.endsWith(tagRef))
  return tagLine?.split("\t")[0] ?? null
}

export const remoteTagFetchRef = (tag: string) => `refs/mini-orch-release/${tag}`

export const fetchRemoteTag = (tag: string, cwd = process.cwd()) => {
  gitInherit(["fetch", "origin", `refs/tags/${tag}:${remoteTagFetchRef(tag)}`], cwd)
}

export const resolveLocalTagCommit = (tag: string, cwd = process.cwd()) => {
  try {
    const output = execFileSync("git", ["rev-parse", `refs/tags/${tag}^{commit}`], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
    return output.endsWith("\n") ? output.slice(0, -1) : output
  } catch {
    return null
  }
}

export const ensureRemoteTagExists = (version: string, cwd = process.cwd()) => {
  const tag = tagName(version)
  const commit = resolveRemoteTagCommit(tag, cwd)

  if (!commit) {
    throw new Error(`Remote tag ${tag} does not exist on origin. Push the tag before creating a GitHub Release.`)
  }

  fetchRemoteTag(tag, cwd)

  const fetchedCommit = gitOutput(["rev-parse", `${remoteTagFetchRef(tag)}^{commit}`], cwd)
  if (fetchedCommit !== commit) {
    throw new Error(`Remote tag ${tag} fetched as ${fetchedCommit}, expected ${commit}.`)
  }

  const tagVersion = readVersionAtCommit(fetchedCommit, cwd)
  if (tagVersion !== version) {
    throw new Error(`Remote tag ${tag} points to a commit with version ${tagVersion}, expected ${version}.`)
  }

  return commit
}

export const ensureRemoteTagMatchesHead = (version: string, cwd = process.cwd()) => {
  const commit = ensureRemoteTagExists(version, cwd)
  const head = gitOutput(["rev-parse", "HEAD"], cwd)

  if (commit !== head) {
    throw new Error(
      `Remote tag ${tagName(version)} points to ${commit}, but HEAD is ${head}. Fix the remote tag before continuing.`,
    )
  }

  return commit
}

const ensureLocalTagMatchesHead = (tag: string, cwd = process.cwd()) => {
  const head = gitOutput(["rev-parse", "HEAD"], cwd)
  const tagCommit = resolveLocalTagCommit(tag, cwd)

  if (tagCommit && tagCommit !== head) {
    throw new Error(
      `Local tag ${tag} points to ${tagCommit}, but HEAD is ${head}. Delete or move the tag before retrying.`,
    )
  }

  return tagCommit !== null
}

const ensureHeadVersion = (version: string, cwd = process.cwd()) => {
  const headVersion = readVersionAtCommit("HEAD", cwd)
  if (headVersion !== version) {
    throw new Error(`HEAD commit has version ${headVersion}, but package.json specifies ${version}.`)
  }
}

export const finalizeGitRelease = (version: string, cwd = process.cwd()) => {
  const tag = tagName(version)

  if (resolveRemoteTagCommit(tag, cwd)) {
    ensureRemoteTagMatchesHead(version, cwd)
    return
  }

  const changed = getChangedTrackedFiles(cwd)
  if (changed.length > 0) {
    ensureOnlyVersionFilesChanged(cwd)

    for (const file of changed) {
      gitInherit(["add", "--", file], cwd)
    }

    gitInherit(["commit", "-m", `chore: release ${tag}`], cwd)
  }

  ensureHeadVersion(version, cwd)

  if (!ensureLocalTagMatchesHead(tag, cwd)) {
    gitInherit(["tag", tag], cwd)
  }

  gitInherit(["push", "origin", "HEAD"], cwd)
  gitInherit(["push", "origin", tag], cwd)
}
