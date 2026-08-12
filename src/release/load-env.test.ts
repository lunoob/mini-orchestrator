import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { loadReleaseEnv } from "./load-env.js"

const originalToken = process.env.GITHUB_TOKEN

afterEach(() => {
  if (originalToken == null) {
    delete process.env.GITHUB_TOKEN
  } else {
    process.env.GITHUB_TOKEN = originalToken
  }
})

describe("loadReleaseEnv", () => {
  it("loads GITHUB_TOKEN from the project .env file", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "release-env-test-"))
    writeFileSync(path.join(dir, ".env"), "GITHUB_TOKEN=from-env-file\n", "utf8")
    delete process.env.GITHUB_TOKEN

    expect(loadReleaseEnv(dir)).toBe("from-env-file")
    rmSync(dir, { recursive: true, force: true })
  })

  it("prefers an existing shell token over the .env file", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "release-env-test-"))
    writeFileSync(path.join(dir, ".env"), "GITHUB_TOKEN=from-env-file\n", "utf8")
    process.env.GITHUB_TOKEN = "from-shell"

    expect(loadReleaseEnv(dir)).toBe("from-shell")
    rmSync(dir, { recursive: true, force: true })
  })

  it("throws a clear error when the token is missing", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "release-env-test-"))
    delete process.env.GITHUB_TOKEN

    expect(() => loadReleaseEnv(dir)).toThrow("GITHUB_TOKEN is required")
    rmSync(dir, { recursive: true, force: true })
  })
})
