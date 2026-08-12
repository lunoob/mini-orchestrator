import semver from "semver"

export type VersionIncrement = "patch" | "minor" | "major"

export const isPrerelease = (version: string) => semver.prerelease(version) !== null

export const nextStagingVersion = (current: string) => {
  if (!semver.valid(current)) throw new Error(`Invalid version: ${current}`)

  const staged = current.match(/^(\d+\.\d+\.\d+)-staging\.(\d+)$/)
  if (staged) return `${staged[1]}-staging.${Number(staged[2]) + 1}`

  return `${current.split("-")[0]}-staging.0`
}

export const nextProductionVersion = (base: string, increment: VersionIncrement) => {
  const next = semver.inc(base, increment)
  if (!next) throw new Error(`Cannot increment ${base} by ${increment}.`)
  return next
}
