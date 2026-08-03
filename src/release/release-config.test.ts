import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

const root = path.resolve(import.meta.dirname, "../..")
const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"))
const releaseConfig = JSON.parse(readFileSync(path.join(root, ".release-it.json"), "utf8"))

describe("release configuration", () => {
  it("exposes the pnpm release entrypoint", () => {
    expect(packageJson.scripts.release).toBe("release-it")
  })

  it("publishes npm and creates a GitHub release with generated notes", () => {
    expect(releaseConfig.npm).toMatchObject({ publish: true })
    expect(releaseConfig.github).toMatchObject({
      release: true,
      autoGenerate: true,
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
