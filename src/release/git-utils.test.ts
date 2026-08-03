import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import {
  ensureRemoteTagExists,
  ensureRemoteTagMatchesHead,
  finalizeGitRelease,
  parseChangedTrackedFiles,
  resolveLocalTagCommit,
  resolveRemoteTagCommit,
} from "./git-utils.js"

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

const git = (cwd: string, ...args: string[]) => {
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" })
}

const createTempDir = (prefix: string) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

const writePackageJson = (cwd: string, version: string) => {
  writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ name: "mini-orch", version }), "utf8")
}

const initRepo = (version = "1.0.0") => {
  const repo = createTempDir("release-git-repo-")
  const origin = createTempDir("release-git-origin-")

  git(repo, "init", "-b", "main")
  git(origin, "init", "--bare", "-b", "main")
  git(repo, "config", "user.email", "release@test.local")
  git(repo, "config", "user.name", "Release Test")
  writePackageJson(repo, version)
  git(repo, "add", "package.json")
  git(repo, "commit", "-m", "init")
  git(repo, "remote", "add", "origin", origin)

  return { repo, origin }
}

const pushToOrigin = (repo: string, ref = "main") => {
  git(repo, "push", "-u", "origin", ref)
}

describe("parseChangedTrackedFiles", () => {
  it("ignores untracked files", () => {
    expect(parseChangedTrackedFiles("?? notes.txt")).toEqual([])
  })

  it("collects modified tracked files", () => {
    expect(parseChangedTrackedFiles(" M package.json\n M src/foo.ts")).toEqual(["package.json", "src/foo.ts"])
  })

  it("collects staged and unstaged version file changes", () => {
    expect(parseChangedTrackedFiles("M  package.json")).toEqual(["package.json"])
  })

  it("collects renamed file targets", () => {
    expect(parseChangedTrackedFiles("R  old-name.ts -> new-name.ts")).toEqual(["new-name.ts"])
  })
})

describe("git release integration", () => {
  it("resolves lightweight remote tags", () => {
    const { repo } = initRepo("1.0.0")
    git(repo, "tag", "v1.0.0")
    pushToOrigin(repo)
    git(repo, "push", "origin", "v1.0.0")

    expect(resolveRemoteTagCommit("v1.0.0", repo)).toBeTruthy()
    expect(() => ensureRemoteTagExists("1.0.0", repo)).not.toThrow()
  })

  it("fetches remote tags before validating package.json at the tagged commit", () => {
    const { repo } = initRepo("1.0.0")
    pushToOrigin(repo)
    git(repo, "tag", "v1.0.0")
    git(repo, "push", "origin", "v1.0.0")
    git(repo, "tag", "-d", "v1.0.0")

    expect(resolveLocalTagCommit("v1.0.0", repo)).toBeNull()
    expect(() => ensureRemoteTagExists("1.0.0", repo)).not.toThrow()
  })

  it("validates remote tags when a local tag points to the wrong commit", () => {
    const { repo } = initRepo("0.9.0")
    pushToOrigin(repo)

    writePackageJson(repo, "1.0.0")
    git(repo, "add", "package.json")
    git(repo, "commit", "-m", "release 1.0.0")
    pushToOrigin(repo)

    git(repo, "tag", "v1.0.0")
    git(repo, "push", "origin", "v1.0.0")

    const wrongCommit = execFileSync("git", ["rev-parse", "HEAD~1"], { cwd: repo, encoding: "utf8" }).trim()
    git(repo, "tag", "-f", "v1.0.0", wrongCommit)

    expect(resolveLocalTagCommit("v1.0.0", repo)).toBe(wrongCommit)
    expect(() => ensureRemoteTagExists("1.0.0", repo)).not.toThrow()
  })

  it("resolves annotated remote tags", () => {
    const { repo } = initRepo("1.0.0")
    git(repo, "tag", "-a", "v1.0.0", "-m", "release 1.0.0")
    pushToOrigin(repo)
    git(repo, "push", "origin", "v1.0.0")

    expect(resolveRemoteTagCommit("v1.0.0", repo)).toBeTruthy()
    expect(() => ensureRemoteTagExists("1.0.0", repo)).not.toThrow()
  })

  it("is a no-op when the remote tag already exists", () => {
    const { repo } = initRepo("1.0.0")
    git(repo, "tag", "v1.0.0")
    pushToOrigin(repo)
    git(repo, "push", "origin", "v1.0.0")

    const headBefore = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim()
    finalizeGitRelease("1.0.0", repo)
    const headAfter = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim()

    expect(headAfter).toBe(headBefore)
  })

  it("throws when a local tag points to the wrong commit", () => {
    const { repo } = initRepo("0.9.0")
    pushToOrigin(repo)

    writePackageJson(repo, "1.0.0")
    git(repo, "add", "package.json")
    git(repo, "commit", "-m", "bump version")

    const wrongCommit = execFileSync("git", ["rev-parse", "HEAD~1"], { cwd: repo, encoding: "utf8" }).trim()
    git(repo, "tag", "v1.0.0", wrongCommit)

    expect(() => finalizeGitRelease("1.0.0", repo)).toThrow(/Local tag v1\.0\.0 points to/)
  })

  it("retries push when commit and local tag exist but remote tag is missing", () => {
    const { repo } = initRepo("0.9.0")
    pushToOrigin(repo)

    writePackageJson(repo, "1.0.0")
    git(repo, "add", "package.json")
    git(repo, "commit", "-m", "chore: release v1.0.0")
    git(repo, "tag", "v1.0.0")
    git(repo, "push", "origin", "HEAD")

    expect(resolveRemoteTagCommit("v1.0.0", repo)).toBeNull()
    expect(resolveLocalTagCommit("v1.0.0", repo)).toBeTruthy()

    finalizeGitRelease("1.0.0", repo)

    expect(resolveRemoteTagCommit("v1.0.0", repo)).toBeTruthy()
    expect(() => ensureRemoteTagExists("1.0.0", repo)).not.toThrow()
  })

  it("creates commit, tag, and push for pending version file changes", () => {
    const { repo } = initRepo("0.9.0")
    pushToOrigin(repo)

    writePackageJson(repo, "1.0.0")
    finalizeGitRelease("1.0.0", repo)

    expect(resolveLocalTagCommit("v1.0.0", repo)).toBeTruthy()
    expect(resolveRemoteTagCommit("v1.0.0", repo)).toBeTruthy()
    expect(() => ensureRemoteTagExists("1.0.0", repo)).not.toThrow()
  })

  it("throws when remote tag version is correct but points to the wrong commit", () => {
    const { repo } = initRepo("1.0.0")
    pushToOrigin(repo)
    git(repo, "tag", "v1.0.0")
    git(repo, "push", "origin", "v1.0.0")

    writeFileSync(
      path.join(repo, "package.json"),
      JSON.stringify({ name: "mini-orch", version: "1.0.0", description: "changed" }),
      "utf8",
    )
    git(repo, "add", "package.json")
    git(repo, "commit", "-m", "other change")
    pushToOrigin(repo)

    expect(() => finalizeGitRelease("1.0.0", repo)).toThrow(/Remote tag v1\.0\.0 points to/)
    expect(() => ensureRemoteTagMatchesHead("1.0.0", repo)).toThrow(/Remote tag v1\.0\.0 points to/)
    expect(() => ensureRemoteTagExists("1.0.0", repo)).not.toThrow()
  })

  it("allows GitHub release validation when main has moved past the release tag", () => {
    const { repo } = initRepo("1.0.0")
    pushToOrigin(repo)
    git(repo, "tag", "v1.0.0")
    git(repo, "push", "origin", "v1.0.0")

    writeFileSync(path.join(repo, "README.md"), "next change", "utf8")
    git(repo, "add", "README.md")
    git(repo, "commit", "-m", "main moved forward")

    expect(() => ensureRemoteTagExists("1.0.0", repo)).not.toThrow()
    expect(() => ensureRemoteTagMatchesHead("1.0.0", repo)).toThrow(/Remote tag v1\.0\.0 points to/)
  })

  it("rejects non-version package.json changes in release commit", () => {
    const { repo } = initRepo("0.9.0")
    pushToOrigin(repo)

    writeFileSync(
      path.join(repo, "package.json"),
      JSON.stringify({ name: "mini-orch", version: "1.0.0", description: "new" }),
      "utf8",
    )

    expect(() => finalizeGitRelease("1.0.0", repo)).toThrow(/only allows package\.json version field changes/)
  })
})
