import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"

import { readPackageJson, parseReleaseVersion, resolveReleaseVersion, tagName } from "./version.js"

describe("version helpers", () => {
  it("reads package name and version", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "release-version-test-"))
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "mini-orch", version: "1.2.3" }), "utf8")

    expect(readPackageJson(dir)).toEqual({ name: "mini-orch", version: "1.2.3" })
    expect(tagName("1.2.3")).toBe("v1.2.3")
    rmSync(dir, { recursive: true, force: true })
  })

  it("reads an explicit release version from argv", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "release-version-test-"))
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "mini-orch", version: "1.0.0" }), "utf8")

    expect(resolveReleaseVersion(["node", "script.ts", "0.1.8"], dir)).toBe("0.1.8")
    expect(resolveReleaseVersion(["node", "script.ts", "--", "0.1.8"], dir)).toBe("0.1.8")
    expect(resolveReleaseVersion(["node", "script.ts"], dir)).toBe("1.0.0")
    rmSync(dir, { recursive: true, force: true })
  })

  it("rejects invalid explicit release versions", () => {
    expect(() => parseReleaseVersion("1.2.3abc")).toThrow("Release version must be a semver like 1.2.3.")
    expect(() => parseReleaseVersion("1.2.3.4")).toThrow("Release version must be a semver like 1.2.3.")
    expect(parseReleaseVersion("1.2.3")).toBe("1.2.3")
  })
})
