import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

import type { IssueConfig } from "../types.js"

export const CHECKPOINT_VERSION = 3

export type NeedsCheckCheckpoint = {
  baseSha: string | undefined
  cannotVerifySummary: string | null
  configPath: string
  createdAt: string
  hasGit: boolean
  implementerSessionId: string
  maxReviewRounds: number
  projectDir: string
  reviewOutput: string
  reviewerSessionId: string
  reuseCurrentPane: boolean
  round: number
  sessionBaseUrl: string
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
    if (checkpoint.version === 2) {
      throw new Error(
        `[Checkpoint] Unsupported checkpoint version 2. ` +
        `mini-orch v3+ uses session-based agent management; v2 checkpoints store Herdr pane IDs which are no longer valid. ` +
        `Please re-run the workflow from the start or use an older mini-orch version to complete this checkpoint.`,
      )
    }
    throw new Error(
      `[Checkpoint] Unsupported checkpoint version: ${checkpoint.version}. ` +
      `This version of mini-orch only supports version ${CHECKPOINT_VERSION}.`,
    )
  }

  return checkpoint
}
