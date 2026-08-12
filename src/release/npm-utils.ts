import { execFileSync } from "node:child_process"

import semver from "semver"

import { executable } from "./run-command.js"

export const getLatestPublishedVersion = (
  packageName: string,
  exec: typeof execFileSync = execFileSync,
): string | null => {
  try {
    const output = exec(executable("npm"), ["view", packageName, "version"], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim()
    const version = output.split("\n").at(-1)?.trim() ?? ""
    return semver.valid(version)
  } catch {
    return null
  }
}

export const ensureNpmVersionPublished = (
  packageName: string,
  version: string,
  exec: typeof execFileSync = execFileSync,
) => {
  const spec = `${packageName}@${version}`

  let published: string
  try {
    published = exec(executable("npm"), ["view", spec, "version"], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim()
  } catch (error) {
    throw new Error(`Version ${version} is not published to npm. Run pnpm publish before release:git.`, {
      cause: error,
    })
  }

  if (published !== version) {
    throw new Error(`npm registry returned version ${published} for ${spec}, expected ${version}.`)
  }
}
