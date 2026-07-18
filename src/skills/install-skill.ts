import { access, constants, lstat, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { stdin as input, stdout as output } from "node:process"
import * as readline from "node:readline/promises"
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

export type SkillInfo = {
  name: string
  installed: boolean
}

export type SkillSelectionResult =
  | { ok: true; selected: string[] }
  | { ok: false; message: string }

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

/** 列出源目录下包含 SKILL.md 的 skill 名称 */
export const listAvailableSkills = async (sourceDir: string): Promise<string[]> => {
  try {
    const entries = await readdir(sourceDir, { withFileTypes: true })
    const skills: string[] = []

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      try {
        await access(path.join(sourceDir, entry.name, "SKILL.md"), constants.R_OK)
        skills.push(entry.name)
      } catch {
        // 跳过不含 SKILL.md 的目录
      }
    }

    return skills.sort()
  } catch {
    return []
  }
}

/** 检查目标 skill 是否已安装 */
export const isSkillInstalled = async (target: string): Promise<boolean> => {
  try {
    await lstat(target)
    return true
  } catch {
    return false
  }
}

/** 获取 skill 安装状态列表 */
export const getSkillInfos = async (
  sourceDir: string,
  targetBaseDir: string,
): Promise<SkillInfo[]> => {
  const names = await listAvailableSkills(sourceDir)
  return Promise.all(
    names.map(async name => ({
      name,
      installed: await isSkillInstalled(path.join(targetBaseDir, name)),
    })),
  )
}

/** 解析用户输入的编号选择 */
export const parseSkillSelection = (
  value: string,
  skills: string[],
): SkillSelectionResult => {
  const trimmed = value.trim()
  if (!trimmed) return { ok: true, selected: [] }
  if (trimmed.toLowerCase() === "all") return { ok: true, selected: [...skills] }

  const parts = trimmed.split(/[,，\s]+/).map(part => part.trim()).filter(Boolean)
  const selected: string[] = []

  for (const part of parts) {
    const index = Number(part)
    if (!Number.isInteger(index) || index < 1 || index > skills.length) {
      return { ok: false, message: `无效选择：${part}` }
    }
    const skill = skills[index - 1]
    if (!selected.includes(skill)) selected.push(skill)
  }

  return { ok: true, selected }
}

/** 交互式选择 skill */
export const promptSkillSelection = async (
  skills: SkillInfo[],
  action: "install" | "uninstall",
): Promise<string[]> => {
  if (skills.length === 0) return []

  const verb = action === "install" ? "安装" : "卸载"
  console.log(`\n请选择要${verb}的 skill（输入编号，逗号分隔；all 全选；回车取消）:\n`)

  skills.forEach((skill, index) => {
    const status = skill.installed ? "已安装" : "未安装"
    const suffix = action === "install" ? ` (${status})` : ""
    console.log(`  ${index + 1}. ${skill.name}${suffix}`)
  })
  console.log()

  const rl = readline.createInterface({ input, output })
  try {
    while (true) {
      const answer = (await rl.question("请选择: ")).trim()
      if (!answer) return []

      const parsed = parseSkillSelection(answer, skills.map(skill => skill.name))
      if (!parsed.ok) {
        console.log(`[Install] ${parsed.message}，请重试。`)
        continue
      }

      return parsed.selected
    }
  } finally {
    rl.close()
  }
}

/** 安装 skill 到目标目录 */
export const installSkill = async (
  source: string,
  target: string,
  options?: Partial<InstallOptions>,
): Promise<InstallResult> => {
  const { mode = "symlink", force = false } = options ?? {}

  try {
    await access(source, constants.R_OK)
  } catch {
    return { success: false, path: target, message: `源目录不存在：${source}` }
  }

  try {
    await lstat(target)
    if (!force) {
      return {
        success: false,
        path: target,
        message: `目标已存在：${target}。使用 --force 覆盖，或先执行 uninstall。`,
      }
    }
    await rm(target, { recursive: true, force: true })
  } catch {
    // 目标不存在，继续
  }

  await mkdir(path.dirname(target), { recursive: true })

  if (mode === "symlink") {
    await symlink(source, target)
    return { success: true, path: target, message: `已创建软链接：${target} → ${source}` }
  }

  await copyDir(source, target)
  return { success: true, path: target, message: `已复制到：${target}` }
}

/** 批量安装选中的 skill */
export const installSelectedSkills = async (
  sourceDir: string,
  targetBaseDir: string,
  skillNames: string[],
  options?: Partial<InstallOptions>,
): Promise<InstallResult[]> => {
  const results: InstallResult[] = []
  for (const name of skillNames) {
    const result = await installSkill(
      path.join(sourceDir, name),
      path.join(targetBaseDir, name),
      options,
    )
    results.push({ ...result, message: `${name}: ${result.message}` })
  }
  return results
}

/** 卸载 skill（移除目标目录/链接） */
export const uninstallSkill = async (
  target: string,
  options?: { force?: boolean },
): Promise<InstallResult> => {
  const { force = false } = options ?? {}

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

/** 批量卸载选中的 skill */
export const uninstallSelectedSkills = async (
  targetBaseDir: string,
  skillNames: string[],
  options?: { force?: boolean },
): Promise<InstallResult[]> => {
  const results: InstallResult[] = []
  for (const name of skillNames) {
    const result = await uninstallSkill(path.join(targetBaseDir, name), options)
    results.push({ ...result, message: `${name}: ${result.message}` })
  }
  return results
}
