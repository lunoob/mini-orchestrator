import { readFileSync } from "node:fs"

import semver from "semver"

export const VERSION_FILES = ["package.json", "package-lock.json"] as const

export const readPackageJson = (cwd = process.cwd()) => {
  const packageJson = JSON.parse(readFileSync(`${cwd}/package.json`, "utf8")) as {
    name?: unknown
    version?: unknown
  }

  if (typeof packageJson.name !== "string") throw new Error("package.json name is missing.")
  if (typeof packageJson.version !== "string") throw new Error("package.json version is missing.")

  return { name: packageJson.name, version: packageJson.version }
}

export const readVersion = (cwd = process.cwd()) => readPackageJson(cwd).version

export const parseReleaseVersion = (value: string) => {
  const version = semver.valid(value)
  if (!version) throw new Error("Release version must be a semver like 1.2.3.")
  return version
}

export const resolveReleaseVersion = (argv: string[], cwd = process.cwd()) => {
  const argument = argv.slice(2).find(value => value !== "--")
  if (argument) return parseReleaseVersion(argument)

  return readVersion(cwd)
}

export const tagName = (version: string) => `v${version}`
