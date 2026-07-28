import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

import type { ParsedArgs } from "../types.js"

const RESUME_ARGS = new Set(["resume-from", "needs-check-action", "needs-check-notes", "help"])

export type WorkflowRunContext = {
  runId: string
  runDirectory: string
}

export type WorkflowRunMetadata = {
  runId: string
  createdAt: string
  configPath: string
  specPath: string
  cliArgs: Record<string, string>
}

const getIdentityArgs = (args: ParsedArgs): Record<string, string> => {
  const entries = Object.entries(args)
    .filter(([key]) => !RESUME_ARGS.has(key))
    .sort(([a], [b]) => a.localeCompare(b))
  return Object.fromEntries(entries)
}

export const createWorkflowRunContext = async (
  projectDir: string,
  configPath: string,
  configContent: string,
  specPath: string,
  specContent: string,
  args: ParsedArgs,
): Promise<WorkflowRunContext> => {
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
  const shortHash = createHash("sha256").update(canonicalInput).digest("hex").slice(0, 8)
  const specName = path.basename(resolvedSpecPath, path.extname(resolvedSpecPath))
  const runId = `${specName}-${shortHash}`
  const runDirectory = path.join(projectDir, ".orchestrator", runId)

  await mkdir(runDirectory, { recursive: true })
  const metadata: WorkflowRunMetadata = {
    cliArgs: identityArgs,
    configPath: resolvedConfigPath,
    createdAt: new Date().toISOString(),
    runId,
    specPath: resolvedSpecPath,
  }
  await writeFile(path.join(runDirectory, "run.json"), JSON.stringify(metadata, null, 2), "utf8")
  return { runDirectory, runId }
}
