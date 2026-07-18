import { fileURLToPath } from "node:url"
import path from "node:path"

import { getShellRcPath, installAlias, uninstallAlias } from "../src/shell/install-alias.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MAIN_TS_PATH = path.resolve(__dirname, "../src/main.ts")

const showUsage = () => {
  console.log(`[Install]
用法:
  pnpm run install-alias              # 在 shell rc 中安装 start-orchestrator 别名
  pnpm run install-alias -- --force   # 覆盖已有别名
  pnpm run uninstall-alias            # 卸载别名

选项:
  --rc <path>           指定 shell rc 文件（默认根据 $SHELL 选择 ~/.zshrc 或 ~/.bashrc）
  --force               覆盖已有别名
  --uninstall           卸载别名
  --help                显示此帮助
`)
}

const main = async () => {
  const args = process.argv.slice(2)

  if (args.includes("--help") || args.includes("-h")) {
    showUsage()
    process.exit(0)
  }

  const rcIndex = args.indexOf("--rc")
  const rcPath = rcIndex !== -1 ? path.resolve(args[rcIndex + 1] ?? "") : getShellRcPath()
  const force = args.includes("--force") || args.includes("-f")
  const uninstall = args.includes("--uninstall")

  if (rcIndex !== -1 && !args[rcIndex + 1]) {
    console.error("[Install] --rc 需要指定文件路径")
    process.exit(1)
  }

  if (uninstall) {
    const result = await uninstallAlias(rcPath)
    console.log(`[Install] ${result.message}`)
    process.exit(result.success ? 0 : 1)
  }

  const result = await installAlias(MAIN_TS_PATH, rcPath, { force })
  console.log(`[Install] ${result.message}`)
  process.exit(result.success ? 0 : 1)
}

main()
