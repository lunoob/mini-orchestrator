import { fileURLToPath } from "node:url"
import path from "node:path"
import os from "node:os"

import { installSkill, SKILL_NAME, uninstallSkill } from "../src/install-skill.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SOURCE_DIR = path.resolve(__dirname, "../skills", SKILL_NAME)
const TARGET_DIR = path.join(os.homedir(), ".agents", "skills", SKILL_NAME)

const showUsage = () => {
  console.log(`
用法:
  npx tsx scripts/install-skill.ts              # 默认以软链接安装
  npx tsx scripts/install-skill.ts --mode copy  # 以复制模式安装
  npx tsx scripts/install-skill.ts --force      # 覆盖已有安装
  npx tsx scripts/install-skill.ts --uninstall  # 卸载

选项:
  --mode symlink|copy   安装模式（默认 symlink）
  --force               覆盖已有目标
  --uninstall           卸载 skill
  --help                显示此帮助
`)
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
    console.error(`无效模式：${mode}，可选值：symlink、copy`)
    process.exit(1)
  }

  if (uninstall) {
    const result = await uninstallSkill(TARGET_DIR, { force })
    console.log(result.message)
    process.exit(result.success ? 0 : 1)
  }

  const result = await installSkill(SOURCE_DIR, TARGET_DIR, { mode, force })
  console.log(result.message)
  process.exit(result.success ? 0 : 1)
}

main()
