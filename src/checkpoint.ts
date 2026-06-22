import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

export const CHECKPOINT_VERSION = 1

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
  specPath: string
  version: typeof CHECKPOINT_VERSION
}

export type NeedsCheckCheckpointInput = Omit<NeedsCheckCheckpoint, "createdAt" | "version">

export const writeNeedsCheckCheckpoint = async (
  projectDir: string,
  data: NeedsCheckCheckpointInput,
) => {
  const dir = path.join(projectDir, ".orchestrator")
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
    throw new Error(`Unsupported checkpoint version: ${checkpoint.version}`)
  }

  return checkpoint
}
