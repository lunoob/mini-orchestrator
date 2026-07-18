import { access, appendFile, constants, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

export const ALIAS_NAME = "start-orchestrator"
export const ALIAS_MARKER_START = "# mini-orchestrator:start-orchestrator"
export const ALIAS_MARKER_END = "# mini-orchestrator:end"

export type InstallAliasResult = {
  success: boolean
  path: string
  message: string
}

export const buildAliasBlock = (mainTsPath: string): string => {
  const aliasLine = `alias ${ALIAS_NAME}='npx tsx ${mainTsPath}'`
  return `${ALIAS_MARKER_START}\n${aliasLine}\n${ALIAS_MARKER_END}`
}

export const getShellRcPath = (): string => {
  const shell = process.env.SHELL ?? ""
  if (shell.includes("zsh")) return path.join(os.homedir(), ".zshrc")
  if (shell.includes("bash")) return path.join(os.homedir(), ".bashrc")
  return path.join(os.homedir(), ".zshrc")
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const hasAliasBlock = (content: string) =>
  content.includes(ALIAS_MARKER_START) && content.includes(ALIAS_MARKER_END)

const removeAliasBlock = (content: string): string => {
  const pattern = new RegExp(
    `\\n?${escapeRegExp(ALIAS_MARKER_START)}[\\s\\S]*?${escapeRegExp(ALIAS_MARKER_END)}\\n?`,
    "g",
  )
  return content.replace(pattern, "").trimEnd()
}

const readRcFile = async (rcPath: string): Promise<string> => {
  try {
    await access(rcPath, constants.R_OK | constants.W_OK)
    return await readFile(rcPath, "utf8")
  } catch {
    return ""
  }
}

/** 在 shell rc 文件中安装 start-orchestrator 别名 */
export const installAlias = async (
  mainTsPath: string,
  rcPath: string,
  options?: { force?: boolean },
): Promise<InstallAliasResult> => {
  const { force = false } = options ?? {}
  const content = await readRcFile(rcPath)

  if (hasAliasBlock(content)) {
    if (!force) {
      return {
        success: false,
        path: rcPath,
        message: `别名已存在于 ${rcPath}。使用 --force 覆盖，或先执行 uninstall-alias。`,
      }
    }

    const updated = `${removeAliasBlock(content)}\n\n${buildAliasBlock(mainTsPath)}\n`
    await writeFile(rcPath, updated, "utf8")
    return {
      success: true,
      path: rcPath,
      message: `已更新别名 ${ALIAS_NAME}（${rcPath}）`,
    }
  }

  const block = buildAliasBlock(mainTsPath)
  if (!content) {
    await writeFile(rcPath, `${block}\n`, "utf8")
  } else {
    const suffix = content.endsWith("\n") ? "" : "\n"
    await appendFile(rcPath, `${suffix}\n${block}\n`, "utf8")
  }

  return {
    success: true,
    path: rcPath,
    message: `已安装别名 ${ALIAS_NAME}（${rcPath}）。请执行 source ${rcPath} 或重启 shell 生效。`,
  }
}

/** 从 shell rc 文件中移除 start-orchestrator 别名 */
export const uninstallAlias = async (rcPath: string): Promise<InstallAliasResult> => {
  const content = await readRcFile(rcPath)

  if (!hasAliasBlock(content)) {
    return {
      success: false,
      path: rcPath,
      message: `未安装别名：${rcPath}`,
    }
  }

  const updated = removeAliasBlock(content)
  await writeFile(rcPath, updated ? `${updated}\n` : "", "utf8")
  return {
    success: true,
    path: rcPath,
    message: `已移除别名 ${ALIAS_NAME}（${rcPath}）`,
  }
}
