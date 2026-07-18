import { fileURLToPath } from "node:url"
import path from "node:path"
import os from "node:os"

import {
  getSkillInfos,
  installSelectedSkills,
  listAvailableSkills,
  promptSkillSelection,
  uninstallSelectedSkills,
} from "../src/skills/install-skill.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SOURCE_DIR = path.resolve(__dirname, "../skills")
const TARGET_BASE_DIR = path.join(os.homedir(), ".agents", "skills")

const showUsage = () => {
  console.log(`[Install]
用法:
  pnpm run install-skill                # 交互式选择并安装
  pnpm run install-skill -- --mode copy # 以复制模式安装
  pnpm run install-skill -- --force     # 覆盖已有安装
  pnpm run uninstall-skill              # 交互式选择并卸载

选项:
  --mode symlink|copy   安装模式（默认 symlink）
  --force               覆盖已有目标 / 强制卸载复制模式目录
  --skill <name>        指定 skill（可重复传入，跳过交互）
  --all                 选择全部可用 skill（跳过交互）
  --uninstall           卸载 skill
  --help                显示此帮助
`)
}

const getArgValues = (args: string[], flag: string): string[] => {
  const values: string[] = []
  for (let index = 0; index < args.length; index++) {
    if (args[index] === flag && args[index + 1]) {
      values.push(args[index + 1])
      index++
    }
  }
  return values
}

const resolveSelectedSkills = async (
  args: string[],
  action: "install" | "uninstall",
): Promise<string[]> => {
  const explicitSkills = getArgValues(args, "--skill")
  if (explicitSkills.length > 0) return explicitSkills

  const available = await listAvailableSkills(SOURCE_DIR)
  if (available.length === 0) {
    console.error(`[Install] 未在 ${SOURCE_DIR} 找到可用 skill`)
    process.exit(1)
  }

  if (args.includes("--all")) {
    if (action === "uninstall") {
      const infos = await getSkillInfos(SOURCE_DIR, TARGET_BASE_DIR)
      return infos.filter(info => info.installed).map(info => info.name)
    }
    return available
  }

  if (!process.stdin.isTTY) {
    console.error("[Install] 非交互模式请使用 --skill <name> 或 --all")
    process.exit(1)
  }

  const infos = await getSkillInfos(SOURCE_DIR, TARGET_BASE_DIR)
  const candidates = action === "install"
    ? infos
    : infos.filter(info => info.installed)

  if (candidates.length === 0) {
    console.log(`[Install] 没有可${action === "install" ? "安装" : "卸载"}的 skill`)
    return []
  }

  return promptSkillSelection(candidates, action)
}

const main = async () => {
  const args = process.argv.slice(2)

  if (args.includes("--help") || args.includes("-h")) {
    showUsage()
    process.exit(0)
  }

  const modeIndex = args.indexOf("--mode")
  const mode = modeIndex !== -1 ? args[modeIndex + 1] : "symlink"
  const force = args.includes("--force") || args.includes("-f")
  const uninstall = args.includes("--uninstall")

  if (mode !== "symlink" && mode !== "copy") {
    console.error(`[Install] 无效模式：${mode}，可选值：symlink、copy`)
    process.exit(1)
  }

  const action = uninstall ? "uninstall" : "install"
  const selected = await resolveSelectedSkills(args, action)

  if (selected.length === 0) {
    console.log("[Install] 未选择任何 skill，已取消")
    process.exit(0)
  }

  const results = uninstall
    ? await uninstallSelectedSkills(TARGET_BASE_DIR, selected, { force })
    : await installSelectedSkills(SOURCE_DIR, TARGET_BASE_DIR, selected, { mode, force })

  for (const result of results) {
    console.log(`[Install] ${result.message}`)
  }

  const hasFailure = results.some(result => !result.success)
  process.exit(hasFailure ? 1 : 0)
}

main()
