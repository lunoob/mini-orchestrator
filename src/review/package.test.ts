import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { readFileSync } from "node:fs"
import path from "node:path"
import os from "node:os"
import { describe, expect, it } from "vitest"

import { generateReviewPackage } from "./package.js"

const git = (cwd: string, args: string[]) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr ?? "unknown error"}`)
  }
  return result.stdout
}

/** 创建带一个初始 commit 的临时 git 仓库 */
const createGitRepo = (dir: string) => {
  git(dir, ["init"])
  git(dir, ["config", "user.email", "test@example.com"])
  git(dir, ["config", "user.name", "Test"])
  writeFileSync(path.join(dir, "tracked.md"), "# tracked\n", "utf8")
  git(dir, ["add", "tracked.md"])
  git(dir, ["commit", "-m", "initial"])
}

const untrackedSectionOf = (pkg: string) => pkg.split("## Untracked Files")[1] ?? ""

describe("generateReviewPackage", () => {
  it("includes full content of untracked source files", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "pkg-test-"))
    createGitRepo(dir)
    mkdirSync(path.join(dir, "src"), { recursive: true })
    writeFileSync(path.join(dir, "src", "new-module.ts"), "export const NEW = 42\n", "utf8")

    const pkgPath = await generateReviewPackage(dir, dir, "HEAD", "HEAD", 1)

    const pkg = readFileSync(pkgPath, "utf8")
    expect(pkg).toContain("### src/new-module.ts")
    expect(pkg).toContain("export const NEW = 42")
  })

  it("excludes .orchestrator and gitignored build output from the untracked section", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "pkg-test-"))
    createGitRepo(dir)
    writeFileSync(path.join(dir, ".gitignore"), "dist/\n", "utf8")
    mkdirSync(path.join(dir, ".orchestrator", "session-1"), { recursive: true })
    writeFileSync(path.join(dir, ".orchestrator", "session-1", "run.json"), "{}", "utf8")
    mkdirSync(path.join(dir, "dist"), { recursive: true })
    writeFileSync(path.join(dir, "dist", "bundle.js"), "console.log(1)\n", "utf8")
    mkdirSync(path.join(dir, "src"), { recursive: true })
    writeFileSync(path.join(dir, "src", "real.ts"), "export const ok = true\n", "utf8")

    const pkgPath = await generateReviewPackage(dir, dir, "HEAD", "HEAD", 1)

    const section = untrackedSectionOf(readFileSync(pkgPath, "utf8"))
    expect(section).toContain("### src/real.ts")
    expect(section).toContain("export const ok = true")
    expect(section).not.toContain(".orchestrator")
    expect(section).not.toContain("dist/bundle.js")
  })

  it("skips binary untracked files with a note", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "pkg-test-"))
    createGitRepo(dir)
    mkdirSync(path.join(dir, "assets"), { recursive: true })
    writeFileSync(path.join(dir, "assets", "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]))

    const pkgPath = await generateReviewPackage(dir, dir, "HEAD", "HEAD", 1)

    const section = untrackedSectionOf(readFileSync(pkgPath, "utf8"))
    expect(section).toContain("### assets/logo.png (skipped: binary file)")
  })

  it("includes full content of oversized untracked source files", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "pkg-test-"))
    createGitRepo(dir)
    mkdirSync(path.join(dir, "src"), { recursive: true })
    const huge = "x".repeat(300 * 1024)
    writeFileSync(path.join(dir, "src", "huge.ts"), huge, "utf8")

    const pkgPath = await generateReviewPackage(dir, dir, "HEAD", "HEAD", 1)

    // 超过 256KB 的源码同样完整写入，Final Reviewer 才能审查到
    const section = untrackedSectionOf(readFileSync(pkgPath, "utf8"))
    expect(section).toContain("### src/huge.ts")
    expect(section).toContain(huge.slice(0, 100))
    expect(section).toContain(huge.slice(-100))
    expect(section).not.toContain("skipped")
  })

  it("omits the untracked section when there are no untracked files", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "pkg-test-"))
    createGitRepo(dir)

    const pkgPath = await generateReviewPackage(dir, dir, "HEAD", "HEAD", 1)

    expect(readFileSync(pkgPath, "utf8")).not.toContain("## Untracked Files")
  })
})
