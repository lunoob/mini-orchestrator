import path from "node:path"

import type { ParsedArgs } from "../types.js"

export const wantsHelp = (argv: string[]) => argv.includes("--help") || argv.includes("-h")

export const printHelp = () => {
  console.log(`[CLI] Usage:
  --config <path> [options]
  --resume-from <path> --needs-check-action <action> [options]

在 Herdr pane 内串起 implementer 与 reviewer agent 工作流。

按配置中的 issues[] 数组顺序串行执行多个 issue。

Options:
  --testStatus              进入 herdr 状态测试模式（无需 --config）
  --config <path>           workflow 配置文件路径（首次启动必填；resume 时可省略）
  --projectDir <path>       项目目录，覆盖配置中的 projectDir
  --maxReviewRounds <n>     最大 review 轮数，覆盖配置中的 maxReviewRounds
  --needs-check-mode <mode> needs_check 交互模式：interactive（默认）| llm
  --resume-from <path>      从 needs_check checkpoint 恢复工作流
  --needs-check-action <a>  恢复时的选择：approve | revise | retry-review | abort
  --needs-check-notes <text> revise / retry-review 时必填的补充说明
  -h, --help                显示此帮助信息

CLI 参数优先级高于 workflow 配置文件中的同名字段。
resume 时可从 checkpoint 读取 configPath，因此可省略 --config。

Skill commands:
  skill install [options]
  skill uninstall [options]
  skill list

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

export const getConfigPath = (args: ParsedArgs) => {
  const configPath = args.config
  if (configPath) return path.resolve(configPath)

  throw new Error("[CLI] Missing required argument --config /absolute/path/to/workflow.json")
}
