import { access, constants, lstat, mkdtemp, mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { describe, expect, it } from "vitest"

import { installSkill, uninstallSkill } from "./install-skill.js"

/** 在临时目录创建源 skill 目录，包含 SKILL.md 文件 */
const createSource = async (dir: string): Promise<string> => {
  const source = path.join(dir, "source")
  await mkdir(source, { recursive: true })
  await writeFile(path.join(source, "SKILL.md"), "# Test Skill\n", "utf8")
  return source
}

describe("installSkill", () => {
  it("default (symlink) mode creates a symlink at target", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "install-test-"))
    const source = await createSource(tmp)
    const target = path.join(tmp, "installed")

    const result = await installSkill(source, target)

    expect(result.success).toBe(true)
    expect(result.path).toBe(target)

    // 验证目标是软链接
    const stats = await lstat(target)
    expect(stats.isSymbolicLink()).toBe(true)
  })

  it("copy mode creates actual file copies at target", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "install-test-"))
    const source = await createSource(tmp)
    const target = path.join(tmp, "installed")

    const result = await installSkill(source, target, { mode: "copy" })

    expect(result.success).toBe(true)
    expect(result.path).toBe(target)

    // 验证目标有文件且不是软链接
    const files = await readdir(target)
    expect(files).toContain("SKILL.md")

    const content = await readFile(path.join(target, "SKILL.md"), "utf8")
    expect(content).toBe("# Test Skill\n")
  })

  it("returns error if source directory does not exist", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "install-test-"))
    const missing = path.join(tmp, "nonexistent")
    const target = path.join(tmp, "installed")

    const result = await installSkill(missing, target)

    expect(result.success).toBe(false)
    expect(result.message).toContain("源目录不存在")
  })

  it("returns error when target already exists without force", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "install-test-"))
    const source = await createSource(tmp)
    const target = path.join(tmp, "existing")

    // 先安装一次
    await installSkill(source, target)

    // 再次安装（无 force）应失败
    const result = await installSkill(source, target)
    expect(result.success).toBe(false)
    expect(result.message).toContain("目标已存在")
  })

  it("force mode overwrites existing target", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "install-test-"))
    const source = await createSource(tmp)
    const target = path.join(tmp, "existing")

    // 先安装
    await installSkill(source, target)

    // force 安装应成功
    const result = await installSkill(source, target, { force: true })
    expect(result.success).toBe(true)
    expect(result.path).toBe(target)
  })

  it("detects broken symlink target as already existing", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "install-test-"))
    const source = await createSource(tmp)
    const target = path.join(tmp, "broken-link")

    // 手动创建损坏软链接（指向不存在的路径）
    await symlink(path.join(tmp, "nonexistent"), target)

    const result = await installSkill(source, target)

    expect(result.success).toBe(false)
    expect(result.message).toContain("目标已存在")
  })

  it("force mode overwrites broken symlink target", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "install-test-"))
    const source = await createSource(tmp)
    const target = path.join(tmp, "broken-link")

    await symlink(path.join(tmp, "nonexistent"), target)

    const result = await installSkill(source, target, { force: true })

    expect(result.success).toBe(true)
    expect(result.path).toBe(target)

    // 旧断链被替换为指向 source 的新链接
    const stats = await lstat(target)
    expect(stats.isSymbolicLink()).toBe(true)
  })
})

describe("uninstallSkill", () => {
  it("removes symlink target", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "uninstall-test-"))
    const source = await createSource(tmp)
    const target = path.join(tmp, "installed")
    await installSkill(source, target)

    const result = await uninstallSkill(target)

    expect(result.success).toBe(true)
    expect(result.message).toContain("已移除")

    // 验证目标已不存在
    await expect(access(target, constants.F_OK)).rejects.toThrow()
  })

  it("returns error when target does not exist", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "uninstall-test-"))
    const target = path.join(tmp, "nonexistent")

    const result = await uninstallSkill(target)
    expect(result.success).toBe(false)
    expect(result.message).toContain("未安装")
  })

  it("force mode removes a copy-installed directory", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "uninstall-test-"))
    const source = await createSource(tmp)
    const target = path.join(tmp, "copied")
    await installSkill(source, target, { mode: "copy" })

    const result = await uninstallSkill(target, { force: true })
    expect(result.success).toBe(true)
    expect(result.message).toContain("已移除")

    await expect(access(target, constants.F_OK)).rejects.toThrow()
  })

  it("refuses to remove a non-symlink directory without force", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "uninstall-test-"))
    const target = path.join(tmp, "mydir")
    await mkdir(target, { recursive: true })
    await writeFile(path.join(target, "file.txt"), "content", "utf8")

    const result = await uninstallSkill(target)
    expect(result.success).toBe(false)
    expect(result.message).toContain("是目录而非软链接")
  })

  it("refuses to remove a regular file without force", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "uninstall-test-"))
    const target = path.join(tmp, "some-file.txt")
    await writeFile(target, "user data", "utf8")

    const result = await uninstallSkill(target)
    expect(result.success).toBe(false)
    expect(result.message).toContain("是普通文件而非软链接")
  })
})
