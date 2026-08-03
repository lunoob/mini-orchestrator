import { execFileSync } from "node:child_process"

import { tagName } from "./version.js"
import { executable } from "./run-command.js"

export const isGhReleaseNotFound = (stderr: string) => {
  const lower = stderr.toLowerCase()
  return lower.includes("release not found") || lower.includes("http 404")
}

export const isGhReleaseAlreadyExists = (stderr: string) => {
  const lower = stderr.toLowerCase()
  if (lower.includes("release already exists")) return true

  return /\balready exists\b/.test(lower) && (lower.includes("release") || lower.includes("tag"))
}

export const inspectGhRelease = (
  tag: string,
  exec: typeof execFileSync = execFileSync,
): { exists: true } | { exists: false } => {
  try {
    exec(executable("gh"), ["release", "view", tag], {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    })
    return { exists: true }
  } catch (error) {
    const err = error as { stderr?: string; message?: string }
    const stderr = err.stderr ?? ""

    if (isGhReleaseNotFound(stderr)) {
      return { exists: false }
    }

    throw new Error(`Failed to inspect GitHub release ${tag}: ${stderr.trim() || err.message}`)
  }
}

export const githubCreateReleaseArgs = (tag: string) => [
  "release",
  "create",
  tag,
  "--generate-notes",
  "--title",
  tag,
  "--verify-tag",
]

export const createGhRelease = (tag: string, exec: typeof execFileSync = execFileSync) => {
  try {
    exec(executable("gh"), githubCreateReleaseArgs(tag), {
      stdio: ["ignore", "inherit", "pipe"],
      encoding: "utf8",
    })
  } catch (error) {
    const err = error as { stderr?: string; message?: string }
    const stderr = err.stderr ?? ""

    if (isGhReleaseAlreadyExists(stderr)) {
      return
    }

    throw new Error(`Failed to create GitHub release ${tag}: ${stderr.trim() || err.message}`)
  }
}

export type GithubReleaseDeps = {
  inspect?: (tag: string) => { exists: true } | { exists: false }
  create?: (tag: string) => void | Promise<void>
}

export const runGithubRelease = async (version: string, deps: GithubReleaseDeps = {}) => {
  const tag = tagName(version)
  const inspect = deps.inspect ?? inspectGhRelease
  const create = deps.create ?? createGhRelease

  if (inspect(tag).exists) {
    return
  }

  await create(tag)
}
