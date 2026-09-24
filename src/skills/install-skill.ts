import { access, constants, lstat, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { checkbox } from "@inquirer/prompts"

import { AGENT_TARGETS, getAgentDisplayPath, getAgentTargetDir, type SkillAgent } from "./agent-targets.js"

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
  installedAgents: SkillAgent[]
}

export type AgentInstallResult = InstallResult & {
  agent: SkillAgent
  skill: string
}

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

/** 获取 skill 在各 agent 下的安装状态 */
export const getSkillInfos = async (
  sourceDir: string,
  agents: SkillAgent[],
  homeDir = os.homedir(),
): Promise<SkillInfo[]> => {
  const names = await listAvailableSkills(sourceDir)
  return Promise.all(names.map(async name => {
    const installedAgents = (await Promise.all(
      agents.map(async agent => (
        await isSkillInstalled(path.join(getAgentTargetDir(agent, homeDir), name)) ? agent : undefined
      )),
    )).filter((agent): agent is SkillAgent => agent !== undefined)

    return { name, installedAgents }
  }))
}

/** 交互式选择 skill */
export const promptSkillSelection = async (
  skills: SkillInfo[],
  action: "install" | "uninstall",
): Promise<string[]> => {
  if (skills.length === 0) return []

  const verb = action === "install" ? "安装" : "卸载"
  return checkbox({
    message: `请选择要${verb}的 skill（Space 选择，Enter 确认）`,
    choices: skills.map(skill => ({
      name: skill.installedAgents.length > 0
        ? `${skill.name}（已安装到 ${skill.installedAgents.join("、")}）`
        : skill.name,
      value: skill.name,
      short: skill.name,
    })),
  })
}

/** 交互式选择目标 agent */
export const promptAgentSelection = async (
  skillNames: string[],
  action: "install" | "uninstall",
  homeDir = os.homedir(),
): Promise<SkillAgent[]> => {
  const installedCounts = await Promise.all(
    AGENT_TARGETS.map(async agent => {
      const installed = await Promise.all(
        skillNames.map(skill => isSkillInstalled(path.join(getAgentTargetDir(agent.id, homeDir), skill))),
      )
      return installed.filter(Boolean).length
    }),
  )
  const verb = action === "install" ? "安装" : "卸载"

  return checkbox({
    message: `请选择要将 skill ${verb}到哪些 agent（Space 选择，Enter 确认）`,
    choices: AGENT_TARGETS.map((agent, index) => {
      const count = installedCounts[index]
      const suffix = count > 0 ? `（${count} 个已选 skill 已安装）` : ""
      const disabled = action === "uninstall" && count === 0 ? "没有已安装的 skill" : false
      return {
        name: `${agent.label} (${getAgentDisplayPath(agent.id)})${suffix}`,
        value: agent.id,
        short: agent.label,
        disabled,
      }
    }),
  })
}

/** 安装 skill 到单个 agent 的目录 */
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
    return { success: true, path: target, message: `安装成功，路径：${target}` }
  }

  await copyDir(source, target)
  return { success: true, path: target, message: `安装成功，路径：${target}` }
}

/** 批量安装到选中的 agent */
export const installSelectedSkillsForAgents = async (
  sourceDir: string,
  agents: SkillAgent[],
  skillNames: string[],
  options?: Partial<InstallOptions>,
  homeDir = os.homedir(),
): Promise<AgentInstallResult[]> => Promise.all(
  agents.flatMap(agent => skillNames.map(async skill => ({
    agent,
    skill,
    ...(await installSkill(
      path.join(sourceDir, skill),
      path.join(getAgentTargetDir(agent, homeDir), skill),
      options,
    )),
  }))),
)

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

/** 批量卸载选中的 agent 下的 skill */
export const uninstallSelectedSkillsForAgents = async (
  agents: SkillAgent[],
  skillNames: string[],
  options?: { force?: boolean },
  homeDir = os.homedir(),
): Promise<AgentInstallResult[]> => Promise.all(
  agents.flatMap(agent => skillNames.map(async skill => ({
    agent,
    skill,
    ...(await uninstallSkill(path.join(getAgentTargetDir(agent, homeDir), skill), options)),
  }))),
)
