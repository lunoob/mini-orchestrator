import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

import type { IssueConfig } from "./types.js"

export const CHECKPOINT_VERSION = 2

export type NeedsCheckCheckpoint = {
  baseSha: string | undefined
  cannotVerifySummary: string | null
  configPath: string
  createdAt: string
  hasGit: boolean
  implementerPane: string
  maxReviewRounds: number
  projectDir: string
  reviewOutput: string
  reviewerPane: string
  reuseCurrentPane: boolean
  round: number
  version: typeof CHECKPOINT_VERSION
  currentIssueIndex: number
  issues: IssueConfig[]
}

export type NeedsCheckCheckpointInput = Omit<NeedsCheckCheckpoint, "createdAt" | "version">

export const writeNeedsCheckCheckpoint = async (
  dir: string,
  data: NeedsCheckCheckpointInput,
) => {
  await mkdir(dir, { recursive: true })

  const filePath = path.join(dir, `needs-check-round-${data.round}-${Date.now()}.json`)
  const checkpoint: NeedsCheckCheckpoint = {
    ...data,
    createdAt: new Date().toISOString(),
    version: CHECKPOINT_VERSION,
  }

  await writeFile(filePath, JSON.stringify(checkpoint, null, 2), "utf8")
  return filePath
}

export const readNeedsCheckCheckpoint = async (filePath: string): Promise<NeedsCheckCheckpoint> => {
  const content = await readFile(filePath, "utf8")
  const checkpoint = JSON.parse(content) as NeedsCheckCheckpoint

  if (checkpoint.version !== CHECKPOINT_VERSION) {
    throw new Error(`[Checkpoint] Unsupported checkpoint version: ${checkpoint.version}`)
  }

  return checkpoint
}
