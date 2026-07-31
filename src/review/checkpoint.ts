import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

import type { AgentRole, AgentSessionHandle } from "../agent/transcript/types.js"
import type { IssueConfig } from "../types.js"
import type { RequestConfig } from "../lib/outcome-parser.js"

export const CHECKPOINT_VERSION = 5

export type NeedsCheckCheckpoint = {
  baseSha: string | undefined
  cannotVerifySummary: string | null
  configPath: string
  createdAt: string
  hasGit: boolean
  implementerPane: string
  implementerSession?: AgentSessionHandle
  maxReviewRounds: number
  projectDir: string
  reviewOutput: string
  reviewerPane: string
  reviewerSession?: AgentSessionHandle
  reuseCurrentPane: boolean
  round: number
  version: typeof CHECKPOINT_VERSION
  currentIssueIndex: number
  issues: IssueConfig[]
  /** intervention 类型: needs_input / invalid_output */
  interventionType?: string
  /** 触发 intervention 的角色 */
  interventionRole?: AgentRole
  /** 原始问题或原因 */
  interventionQuestion?: string
  /** 结构化提问配置（options / recommendation / allowFreeform 等） */
  interventionRequestConfig?: RequestConfig
  /** 触发 intervention 的 workflow 阶段 */
  interventionPhase?: string
  /** post-check 阶段的 review 状态（REVIEW_PASS / REVIEW_NEEDS_CHECK） */
  reviewStatus?: string
  /** 原始 reviewer 输出（post-check intervention 时保留） */
  interventionReviewOutput?: string
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
