import { describe, expect, it, vi } from "vitest"

import {
  createGhRelease,
  githubCreateReleaseArgs,
  inspectGhRelease,
  isGhReleaseAlreadyExists,
  isGhReleaseNotFound,
  runGithubRelease,
} from "./github-release.js"

describe("github release helpers", () => {
  it("treats only not-found errors as missing releases", () => {
    expect(isGhReleaseNotFound("release not found")).toBe(true)
    expect(isGhReleaseNotFound("HTTP 404: Not Found")).toBe(true)
    expect(isGhReleaseNotFound("HTTP 401: Bad credentials")).toBe(false)
    expect(isGhReleaseNotFound("network timeout")).toBe(false)
  })

  it("treats only duplicate errors as already-existing releases", () => {
    expect(isGhReleaseAlreadyExists("release already exists")).toBe(true)
    expect(isGhReleaseAlreadyExists("a release with this tag already exists")).toBe(true)
    expect(isGhReleaseAlreadyExists("asset already exists")).toBe(false)
    expect(isGhReleaseAlreadyExists("HTTP 422: Validation Failed")).toBe(false)
    expect(isGhReleaseAlreadyExists("HTTP 401: Bad credentials")).toBe(false)
  })

  it("rethrows auth and network errors from gh release view", () => {
    const exec = vi.fn(() => {
      const error = new Error("Command failed") as Error & { stderr?: string }
      error.stderr = "HTTP 401: Bad credentials"
      throw error
    })

    expect(() => inspectGhRelease("v1.0.0", exec)).toThrow(/Failed to inspect GitHub release v1\.0\.0/)
  })

  it("returns exists=true when gh release view succeeds", () => {
    const exec = vi.fn()

    expect(inspectGhRelease("v1.0.0", exec)).toEqual({ exists: true })
    expect(exec).toHaveBeenCalledWith("gh", ["release", "view", "v1.0.0"], expect.any(Object))
  })

  it("returns exists=false only for not-found errors", () => {
    const exec = vi.fn(() => {
      const error = new Error("Command failed") as Error & { stderr?: string }
      error.stderr = "release not found"
      throw error
    })

    expect(inspectGhRelease("v1.0.0", exec)).toEqual({ exists: false })
  })

  it("creates releases with verify-tag and generated notes", () => {
    expect(githubCreateReleaseArgs("v1.0.0")).toEqual([
      "release",
      "create",
      "v1.0.0",
      "--generate-notes",
      "--title",
      "v1.0.0",
      "--verify-tag",
    ])
  })

  it("ignores duplicate errors when create races with another process", () => {
    const exec = vi.fn(() => {
      const error = new Error("Command failed") as Error & { stderr?: string }
      error.stderr = "release already exists"
      throw error
    })

    expect(() => createGhRelease("v1.0.0", exec)).not.toThrow()
  })

  it("rethrows unexpected create errors", () => {
    const exec = vi.fn(() => {
      const error = new Error("Command failed") as Error & { stderr?: string }
      error.stderr = "HTTP 401: Bad credentials"
      throw error
    })

    expect(() => createGhRelease("v1.0.0", exec)).toThrow(/Failed to create GitHub release v1\.0\.0/)
  })

  it("rethrows validation failures that are not duplicate releases", () => {
    const exec = vi.fn(() => {
      const error = new Error("Command failed") as Error & { stderr?: string }
      error.stderr = "HTTP 422: Validation Failed (tag does not exist)"
      throw error
    })

    expect(() => createGhRelease("v1.0.0", exec)).toThrow(/Failed to create GitHub release v1\.0\.0/)
  })

  it("rethrows unrelated duplicate resource errors", () => {
    const exec = vi.fn(() => {
      const error = new Error("Command failed") as Error & { stderr?: string }
      error.stderr = "asset already exists"
      throw error
    })

    expect(() => createGhRelease("v1.0.0", exec)).toThrow(/Failed to create GitHub release v1\.0\.0/)
  })
})

describe("runGithubRelease", () => {
  it("skips create when the release already exists", async () => {
    const inspect = vi.fn().mockReturnValue({ exists: true })
    const create = vi.fn()

    await runGithubRelease("1.0.0", { inspect, create })

    expect(inspect).toHaveBeenCalledWith("v1.0.0")
    expect(create).not.toHaveBeenCalled()
  })

  it("creates a release when it does not exist", async () => {
    const inspect = vi.fn().mockReturnValue({ exists: false })
    const create = vi.fn()

    await runGithubRelease("1.0.0", { inspect, create })

    expect(create).toHaveBeenCalledWith("v1.0.0")
  })

  it("treats duplicate create errors as success after a race", async () => {
    const inspect = vi.fn().mockReturnValue({ exists: false })
    const exec = vi.fn(() => {
      const error = new Error("Command failed") as Error & { stderr?: string }
      error.stderr = "release already exists"
      throw error
    })

    await runGithubRelease("1.0.0", {
      inspect,
      create: tag => createGhRelease(tag, exec),
    })

    expect(exec).toHaveBeenCalled()
  })

  it("fails when create returns an unexpected error", async () => {
    const inspect = vi.fn().mockReturnValue({ exists: false })
    const create = vi.fn(() => {
      throw new Error("network timeout")
    })

    await expect(runGithubRelease("1.0.0", { inspect, create })).rejects.toThrow("network timeout")
  })
})
