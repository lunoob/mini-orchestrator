import path from "node:path"

import { getCommandName } from "../command-name.js"
import type { ParsedArgs } from "../types.js"

export const wantsHelp = (argv: string[]) => argv.includes("--help") || argv.includes("-h")

const SUPPORTED_ARGS = new Set(["config"])

export const printHelp = (commandName = getCommandName()) => {
  console.log(`Usage: ${commandName} [options]
       ${commandName} skill <command> [options]

Options:
  --config <path>       workflow 配置文件路径（必填）
  -h, --help            显示帮助信息

Commands:
  skill install         安装 skill
  skill uninstall       卸载 skill
  skill list             查看可用 skill
`)
}

export const parseArgs = (argv: string[]): ParsedArgs => {
  const args: ParsedArgs = {}

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith("--")) continue

    const key = arg.slice(2)
    if (!SUPPORTED_ARGS.has(key)) {
      throw new Error(`[CLI] Unsupported argument --${key}`)
    }

    const value = argv[index + 1]
    if (!value || value.startsWith("--")) {
      args[key] = "true"
      continue
    }

    args[key] = value
    index += 1
  }

  return args
}

export const getConfigPath = (args: ParsedArgs) => {
  const configPath = args.config
  if (configPath) return path.resolve(configPath)

  throw new Error("[CLI] Missing required argument --config /absolute/path/to/workflow.json")
}
