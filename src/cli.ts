import path from "node:path"

import type { ParsedArgs } from "./types.js"

export const wantsHelp = (argv: string[]) => argv.includes("--help") || argv.includes("-h")

export const printHelp = () => {
  console.log(`Usage: run-post-spec.ts --config <path> [options]

在 Herdr pane 内串起 implementer 与 reviewer agent 工作流。

Options:
  --config <path>           workflow 配置文件路径（必填）
  --projectDir <path>       项目目录，覆盖配置中的 projectDir
  --specPath <path>         spec 文件路径，覆盖配置中的 specPath
  --maxReviewRounds <n>     最大 review 轮数，覆盖配置中的 maxReviewRounds
  --reuse-current-pane      复用当前 herdr pane 作为 reviewer，不新建 reviewer pane
  -h, --help                显示此帮助信息

CLI 参数优先级高于 workflow 配置文件中的同名字段。
至少需要为 projectDir、specPath 各提供一种来源（配置或 CLI）。

Examples:
  npx tsx run-post-spec.ts --config workflow.local.json
  start-orchestrator --reuse-current-pane --specPath ./spec.md
  npx tsx run-post-spec.ts --config workflow.local.json --projectDir . --maxReviewRounds 6

Environment:
  HERDR_ENV=1               必须在 Herdr pane 内运行（--help 除外）
`)
}

export const parseArgs = (argv: string[]): ParsedArgs => {
  const args: ParsedArgs = {}

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith("--")) continue

    const key = arg.slice(2)
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

export const isFlagEnabled = (args: ParsedArgs, key: string) => {
  const value = args[key]
  if (value === undefined) return false
  return value !== "false"
}

export const getConfigPath = (args: ParsedArgs) => {
  const configPath = args.config
  if (configPath) return path.resolve(configPath)

  throw new Error("Missing required argument --config /absolute/path/to/workflow.json")
}
