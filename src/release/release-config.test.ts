import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

const root = path.resolve(import.meta.dirname, "../..")
const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"))
const releaseConfig = JSON.parse(readFileSync(path.join(root, ".release-it.json"), "utf8"))

describe("release configuration", () => {
  it("exposes the pnpm release entrypoint", () => {
    expect(packageJson.scripts.release).toBe("tsx scripts/release.ts")
    expect(packageJson.scripts["release:git"]).toBe("tsx scripts/release-git.ts")
    expect(packageJson.scripts["release:github"]).toBe("tsx scripts/release-github.ts")
  })

  it("keeps npm publishing separate from the GitHub release", () => {
    expect(releaseConfig.npm).toMatchObject({ publish: false })
    expect(releaseConfig.github).toMatchObject({
      release: true,
      autoGenerate: true,
      update: true,
    })
  })

  it("keeps release commits and tags aligned with the package version", () => {
    expect(releaseConfig.git).toMatchObject({
      requireBranch: "main",
      commitMessage: "chore: release v${version}",
      tagName: "v${version}",
      push: true,
    })
  })
})
