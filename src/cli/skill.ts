import path from "node:path"
import { fileURLToPath } from "node:url"

import { getCommandName } from "../command-name.js"
import { AGENT_TARGETS, type SkillAgent } from "../skills/agent-targets.js"
import {
  getSkillInfos,
  installSelectedSkillsForAgents,
  listAvailableSkills,
  promptAgentSelection,
  promptSkillSelection,
  uninstallSelectedSkillsForAgents,
  type SkillInfo,
} from "../skills/install-skill.js"

export type SkillAction = "install" | "uninstall" | "list"

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const sourceDir = path.join(projectRoot, "skills")
const allAgents = AGENT_TARGETS.map(agent => agent.id)

export const getSkillSelectionCancelledMessage = (action: "install" | "uninstall") =>
  `[Skill] 未选择要${action === "install" ? "安装" : "卸载"}的 skill，已取消`

export const selectInstalledAgents = (infos: SkillInfo[], skillNames: string[]) => {
  const selected = new Set(skillNames)
  return allAgents.filter(agent => infos.some(info => (
    selected.has(info.name) && info.installedAgents.includes(agent)
  )))
}

export const parseSkillAction = (args: string[]): SkillAction | undefined => {
  const firstArg = args[0]
  if (firstArg === "install" || firstArg === "uninstall" || firstArg === "list") return firstArg
  if (!firstArg) return "install"
  return undefined
}

const showUsage = (commandName = getCommandName()) => {
  console.log(`Usage: ${commandName} skill <command> [options]

Commands:
  install               安装 skill
  uninstall             卸载 skill
  list                  查看可用 skill

Options:
  --mode symlink|copy   安装模式（默认 symlink）
  --force               覆盖已有安装 / 强制卸载复制目录
  --skill <name>        指定 skill（可重复传入，跳过 skill 选择）
  --agent <name>        指定 agent（可重复传入，跳过 agent 选择）
  --all                 安装或卸载全部 skill 到全部 agent（跳过交互）
  -h, --help            显示帮助信息
`)
}

const getArgValues = (args: string[], flag: string): string[] => {
  const values: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== flag || !args[index + 1]) continue
    values.push(args[index + 1])
    index += 1
  }
  return values
}

const isSkillAgent = (value: string): value is SkillAgent =>
  AGENT_TARGETS.some(agent => agent.id === value)

export const parseSkillAgents = (args: string[]): SkillAgent[] | undefined => {
  const values = getArgValues(args, "--agent")
  if (values.length === 0 || values.every(isSkillAgent)) return values as SkillAgent[]
  return undefined
}

const resolveSelectedSkills = async (
  args: string[],
  action: "install" | "uninstall",
): Promise<string[] | undefined> => {
  const explicitSkills = getArgValues(args, "--skill")
  if (explicitSkills.length > 0) return explicitSkills

  const available = await listAvailableSkills(sourceDir)
  if (available.length === 0) {
    console.error(`[Skill] 未在 ${sourceDir} 找到可用 skill`)
    return undefined
  }

  if (args.includes("--all")) {
    if (action === "uninstall") {
      const infos = await getSkillInfos(sourceDir, allAgents)
      return infos.filter(info => info.installedAgents.length > 0).map(info => info.name)
    }
    return available
  }

  if (!process.stdin.isTTY) {
    console.error("[Skill] 非交互模式请使用 --skill <name> 或 --all")
    return undefined
  }

  const infos = await getSkillInfos(sourceDir, allAgents)
  const candidates = action === "install"
    ? infos
    : infos.filter(info => info.installedAgents.length > 0)

  if (candidates.length === 0) {
    console.log(`[Skill] 没有可${action === "install" ? "安装" : "卸载"}的 skill`)
    return undefined
  }

  return promptSkillSelection(candidates, action)
}

const resolveSelectedAgents = async (
  args: string[],
  action: "install" | "uninstall",
  skillNames: string[],
): Promise<SkillAgent[]> => {
  const explicitAgents = parseSkillAgents(args)
  if (explicitAgents === undefined) {
    console.error("[Skill] 不支持的 agent，可选值为 codex、claude-code、cursor")
    return []
  }
  if (explicitAgents.length > 0) return explicitAgents
  if (args.includes("--all")) {
    if (action === "install") return allAgents
    const infos = await getSkillInfos(sourceDir, allAgents)
    return selectInstalledAgents(infos, skillNames)
  }

  if (!process.stdin.isTTY) {
    console.error("[Skill] 非交互模式请使用 --agent <name> 或 --all")
    return []
  }

  return promptAgentSelection(skillNames, action)
}

const agentLabel = (agent: SkillAgent) => AGENT_TARGETS.find(item => item.id === agent)?.label ?? agent

export const runSkillCli = async (args: string[], commandName = getCommandName()): Promise<number> => {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    showUsage(commandName)
    return 0
  }

  const action = parseSkillAction(args)
  if (!action) {
    console.error(`[Skill] 无效命令：${args[0]}，可选命令为 install、uninstall、list`)
    return 1
  }

  if (action === "list") {
    const infos = await getSkillInfos(sourceDir, allAgents)
    if (infos.length === 0) {
      console.log(`[Skill] 未在 ${sourceDir} 找到可用 skill`)
      return 0
    }
    infos.forEach(info => {
      const installed = info.installedAgents.map(agentLabel)
      const suffix = installed.length > 0 ? `（已安装到 ${installed.join("、")}）` : ""
      console.log(`  ${info.name}${suffix}`)
    })
    return 0
  }

  const modeIndex = args.indexOf("--mode")
  const mode = modeIndex === -1 ? "symlink" : args[modeIndex + 1]
  const force = args.includes("--force") || args.includes("-f")

  if (mode !== "symlink" && mode !== "copy") {
    console.error(`[Skill] 无效模式：${mode}，可选值：symlink、copy`)
    return 1
  }

  const selectedSkills = await resolveSelectedSkills(args, action)
  if (selectedSkills === undefined) return 0
  if (selectedSkills.length === 0) {
    console.log(getSkillSelectionCancelledMessage(action))
    return 0
  }

  const selectedAgents = await resolveSelectedAgents(args, action, selectedSkills)
  if (selectedAgents.length === 0) {
    console.log("[Skill] 未选择任何 agent，已取消")
    return 0
  }

  const results = action === "uninstall"
    ? await uninstallSelectedSkillsForAgents(selectedAgents, selectedSkills, { force })
    : await installSelectedSkillsForAgents(sourceDir, selectedAgents, selectedSkills, { mode, force })

  console.log()
  results.forEach(result => console.log(`[Skill] ${agentLabel(result.agent)} / ${result.skill}: ${result.message}`))
  return results.some(result => !result.success) ? 1 : 0
}
