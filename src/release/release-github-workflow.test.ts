import { describe, expect, it, vi } from "vitest"

import { executeReleaseGithub } from "./release-github-workflow.js"

const createDeps = () => ({
  loadEnv: vi.fn(),
  ensureMainBranch: vi.fn(),
  resolveVersion: vi.fn().mockReturnValue("1.0.0"),
  ensureRemoteTagExists: vi.fn(),
  readVersion: vi.fn().mockReturnValue("1.0.0"),
  runGithubRelease: vi.fn(),
  runReleaseIt: vi.fn(),
  argv: ["node", "release-github.ts"],
})

describe("executeReleaseGithub", () => {
  it("runs release-it when the resolved version matches package.json", async () => {
    const deps = createDeps()

    await executeReleaseGithub(deps)

    expect(deps.loadEnv).toHaveBeenCalledOnce()
    expect(deps.ensureMainBranch).toHaveBeenCalledOnce()
    expect(deps.resolveVersion).toHaveBeenCalledWith(deps.argv)
    expect(deps.ensureRemoteTagExists).toHaveBeenCalledWith("1.0.0")
    expect(deps.runReleaseIt).toHaveBeenCalledOnce()
    expect(deps.runGithubRelease).not.toHaveBeenCalled()
  })

  it("uses gh for an explicit historical version retry", async () => {
    const deps = createDeps()
    deps.resolveVersion.mockReturnValue("0.9.0")
    deps.readVersion.mockReturnValue("1.0.0")

    await executeReleaseGithub(deps)

    expect(deps.ensureRemoteTagExists).toHaveBeenCalledWith("0.9.0")
    expect(deps.runGithubRelease).toHaveBeenCalledWith("0.9.0")
    expect(deps.runReleaseIt).not.toHaveBeenCalled()
  })

  it("fails when the remote tag does not exist", async () => {
    const deps = createDeps()
    deps.ensureRemoteTagExists.mockImplementation(() => {
      throw new Error("Remote tag v1.0.0 does not exist on origin.")
    })

    await expect(executeReleaseGithub(deps)).rejects.toThrow("Remote tag v1.0.0 does not exist on origin.")
    expect(deps.runReleaseIt).not.toHaveBeenCalled()
    expect(deps.runGithubRelease).not.toHaveBeenCalled()
  })

  it("fails when not on the main branch", async () => {
    const deps = createDeps()
    deps.ensureMainBranch.mockImplementation(() => {
      throw new Error("Release must run on the main branch.")
    })

    await expect(executeReleaseGithub(deps)).rejects.toThrow("Release must run on the main branch.")
    expect(deps.ensureRemoteTagExists).not.toHaveBeenCalled()
  })

  it("fails when GITHUB_TOKEN is missing", async () => {
    const deps = createDeps()
    deps.loadEnv.mockImplementation(() => {
      throw new Error("GITHUB_TOKEN is required. Set it in .env or the shell environment.")
    })

    await expect(executeReleaseGithub(deps)).rejects.toThrow("GITHUB_TOKEN is required")
    expect(deps.ensureMainBranch).not.toHaveBeenCalled()
  })
})
