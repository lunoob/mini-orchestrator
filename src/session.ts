import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

import type { ParsedArgs } from "./types.js"

/** CLI 参数中与 resume/帮助相关的 key，不计入 session 身份 */
const RESUME_ARGS = new Set(["resume-from", "needs-check-action", "needs-check-notes", "help"])

export type SessionInfo = {
  sessionId: string
  sessionDir: string
}

export type RunMetadata = {
  sessionId: string
  createdAt: string
  configPath: string
  specPath: string
  cliArgs: Record<string, string>
}

/**
 * 过滤出影响调度身份的 CLI 参数，
 * 排除 resume 相关参数和 --help。
 */
const getIdentityArgs = (args: ParsedArgs): Record<string, string> => {
  const entries = Object.entries(args)
    .filter(([key]) => !RESUME_ARGS.has(key))
    .sort(([a], [b]) => a.localeCompare(b))
  return Object.fromEntries(entries)
}

/**
 * 基于 spec 内容、config 内容和 CLI 参数创建 session 目录。
 *
 * 目录名 = `<spec文件名>-<sha256[:8]>`，保证相同输入 → 相同目录。
 * 目录内写入 run.json 记录本次调度的完整元数据。
 */
export const createSession = async (
  projectDir: string,
  configPath: string,
  configContent: string,
  specPath: string,
  specContent: string,
  args: ParsedArgs,
): Promise<SessionInfo> => {
  const resolvedConfigPath = path.resolve(configPath)
  const resolvedSpecPath = path.resolve(specPath)
  const identityArgs = getIdentityArgs(args)

  const canonicalInput = JSON.stringify({
    configPath: resolvedConfigPath,
    configContent,
    specPath: resolvedSpecPath,
    specContent,
    cliArgs: identityArgs,
  })

  const fullHash = createHash("sha256").update(canonicalInput).digest("hex")
  const shortHash = fullHash.slice(0, 8)
  const specName = path.basename(resolvedSpecPath, path.extname(resolvedSpecPath))
  const sessionId = `${specName}-${shortHash}`
  const sessionDir = path.join(projectDir, ".orchestrator", sessionId)

  await mkdir(sessionDir, { recursive: true })

  const runMeta: RunMetadata = {
    sessionId,
    createdAt: new Date().toISOString(),
    configPath: resolvedConfigPath,
    specPath: resolvedSpecPath,
    cliArgs: identityArgs,
  }

  await writeFile(path.join(sessionDir, "run.json"), JSON.stringify(runMeta, null, 2), "utf8")

  return { sessionId, sessionDir }
}
