import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  getSkillInfos,
  installSelectedSkills,
  listAvailableSkills,
  promptSkillSelection,
  uninstallSelectedSkills,
} from "../skills/install-skill.js"

export type SkillAction = "install" | "uninstall" | "list"

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const sourceDir = path.join(projectRoot, "skills")
const targetBaseDir = path.join(os.homedir(), ".agents", "skills")

export const parseSkillAction = (args: string[]): SkillAction | undefined => {
  const firstArg = args[0]
  if (firstArg === "install" || firstArg === "uninstall" || firstArg === "list") {
    return firstArg
  }
  if (args.includes("--uninstall")) return "uninstall"
  if (!firstArg || firstArg.startsWith("-")) return "install"
  return undefined
}

const showUsage = () => {
  console.log(`[Skill]
用法:
  mini-orch skill install                交互式安装 skill
  mini-orch skill uninstall              交互式卸载 skill
  mini-orch skill list                   查看可用 skill

选项:
  --mode symlink|copy   安装模式（默认 symlink）
  --force               覆盖已有安装 / 强制卸载复制目录
  --skill <name>        指定 skill（可重复传入，跳过交互）
  --all                 选择全部可用 skill（跳过交互）
  --uninstall           兼容旧版脚本的卸载参数
  -h, --help            显示此帮助
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

const resolveSelectedSkills = async (
  args: string[],
  action: "install" | "uninstall",
): Promise<string[]> => {
  const explicitSkills = getArgValues(args, "--skill")
  if (explicitSkills.length > 0) return explicitSkills

  const available = await listAvailableSkills(sourceDir)
  if (available.length === 0) {
    console.error(`[Skill] 未在 ${sourceDir} 找到可用 skill`)
    return []
  }

  if (args.includes("--all")) {
    if (action === "uninstall") {
      const infos = await getSkillInfos(sourceDir, targetBaseDir)
      return infos.filter(info => info.installed).map(info => info.name)
    }
    return available
  }

  if (!process.stdin.isTTY) {
    console.error("[Skill] 非交互模式请使用 --skill <name> 或 --all")
    return []
  }

  const infos = await getSkillInfos(sourceDir, targetBaseDir)
  const candidates = action === "install"
    ? infos
    : infos.filter(info => info.installed)

  if (candidates.length === 0) {
    console.log(`[Skill] 没有可${action === "install" ? "安装" : "卸载"}的 skill`)
    return []
  }

  return promptSkillSelection(candidates, action)
}

export const runSkillCli = async (args: string[]): Promise<number> => {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    showUsage()
    return 0
  }

  const action = parseSkillAction(args)
  if (!action) {
    console.error(`[Skill] 无效命令：${args[0]}，可选命令为 install、uninstall、list`)
    return 1
  }

  if (action === "list") {
    const infos = await getSkillInfos(sourceDir, targetBaseDir)
    if (infos.length === 0) {
      console.log(`[Skill] 未在 ${sourceDir} 找到可用 skill`)
      return 0
    }
    infos.forEach(info => {
      console.log(`  ${info.name}${info.installed ? " (已安装)" : ""}`)
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

  const selected = await resolveSelectedSkills(args, action)
  if (selected.length === 0) {
    console.log("[Skill] 未选择任何 skill，已取消")
    return 0
  }

  const results = action === "uninstall"
    ? await uninstallSelectedSkills(targetBaseDir, selected, { force })
    : await installSelectedSkills(sourceDir, targetBaseDir, selected, { mode, force })

  results.forEach(result => console.log(`[Skill] ${result.message}`))
  return results.some(result => !result.success) ? 1 : 0
}
