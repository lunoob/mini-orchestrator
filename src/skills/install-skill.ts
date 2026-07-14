import { access, constants, lstat, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import path from "node:path"

export type InstallOptions = {
  mode: "symlink" | "copy"
  force?: boolean
}

export type InstallResult = {
  success: boolean
  path: string
  message: string
}

export const SKILL_NAME = "run-issue"

/** 递归复制目录内容 */
const copyDir = async (src: string, dest: string): Promise<void> => {
  await mkdir(dest, { recursive: true })
  const entries = await readdir(src, { withFileTypes: true })
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath)
    } else {
      await writeFile(destPath, await readFile(srcPath))
    }
  }
}

/** 安装 skill 到目标目录 */
export const installSkill = async (
  source: string,
  target: string,
  options?: Partial<InstallOptions>,
): Promise<InstallResult> => {
  const { mode = "symlink", force = false } = options ?? {}

  // 校验源目录存在
  try {
    await access(source, constants.R_OK)
  } catch {
    return { success: false, path: target, message: `源目录不存在：${source}` }
  }

  // 检查目标是否已存在
  // 用 lstat 而非 access：access 会跟随软链接，遇到断链会误判为"不存在"
  // 但 symlink(2) 仍会因目录项已存在而抛 EEXIST
  try {
    await lstat(target)
    if (!force) {
      return {
        success: false,
        path: target,
        message: `目标已存在：${target}。使用 --force 覆盖，或先执行 uninstall。`,
      }
    }
    // force 模式下先清理（忽略类型，统一递归删除）
    await rm(target, { recursive: true, force: true })
  } catch {
    // 目标不存在，继续
  }

  // 确保父目录存在
  await mkdir(path.dirname(target), { recursive: true })

  if (mode === "symlink") {
    await symlink(source, target)
    return { success: true, path: target, message: `已创建软链接：${target} → ${source}` }
  }

  // mode === "copy"
  await copyDir(source, target)
  return { success: true, path: target, message: `已复制到：${target}` }
}

/** 卸载 skill（移除目标目录/链接） */
export const uninstallSkill = async (
  target: string,
  options?: { force?: boolean },
): Promise<InstallResult> => {
  const { force = false } = options ?? {}

  // 用 lstat 而非 access：access 会跟随软链接，断链会误判为不存在
  try {
    await lstat(target)
  } catch {
    return { success: false, path: target, message: `未安装：${target}` }
  }

  if (!force) {
    const stats = await lstat(target)
    if (!stats.isSymbolicLink()) {
      const kind = stats.isDirectory() ? "目录" : "普通文件"
      return {
        success: false,
        path: target,
        message: `目标 ${target} 是${kind}而非软链接，确认安全后使用 --force 删除。`,
      }
    }
  }

  await rm(target, { recursive: true, force: true })
  return { success: true, path: target, message: `已移除：${target}` }
}
