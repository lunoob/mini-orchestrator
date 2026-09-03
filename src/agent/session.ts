import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

import type { ParsedArgs } from "../types.js"

const IGNORED_ARGS = new Set(["help"])

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

const getIdentityArgs = (args: ParsedArgs): Record<string, string> => {
  const entries = Object.entries(args)
    .filter(([key]) => !IGNORED_ARGS.has(key))
    .sort(([a], [b]) => a.localeCompare(b))
  return Object.fromEntries(entries)
}

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
  const workflowName = path.basename(resolvedConfigPath, path.extname(resolvedConfigPath))
  const sessionDir = path.join(projectDir, ".orchestrator", workflowName, sessionId)

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
