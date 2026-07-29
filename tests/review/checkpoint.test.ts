import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { describe, expect, it } from "vitest"

import {
  CHECKPOINT_VERSION,
  readNeedsCheckCheckpoint,
  writeNeedsCheckCheckpoint,
  type NeedsCheckCheckpointInput,
} from "@src/review/checkpoint"

const sampleInput = (overrides: Partial<NeedsCheckCheckpointInput> = {}): NeedsCheckCheckpointInput => ({
  baseSha: "abc123",
  cannotVerifySummary: null,
  configPath: "/tmp/workflow.json",
  hasGit: true,
  implementerSessionId: "session-impl-1",
  maxReviewRounds: 4,
  projectDir: "/tmp/project",
  reviewOutput: "REVIEW_NEEDS_CHECK: needs human verification",
  reviewerSessionId: "session-reviewer-1",
  reuseCurrentPane: false,
  round: 2,
  sessionBaseUrl: "http://127.0.0.1:12345",
  currentIssueIndex: 0,
  issues: [{ title: "Add login", specPath: "/tmp/spec.md" }],
  ...overrides,
})

describe("checkpoint v3 (session-based)", () => {
  it("writes a v3 checkpoint with session IDs, not pane IDs", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mini-orch-checkpoint-v3-"))
    try {
      const input = sampleInput()
      const filePath = await writeNeedsCheckCheckpoint(dir, input)

      const checkpoint = await readNeedsCheckCheckpoint(filePath)
      expect(checkpoint.version).toBe(3)
      expect(checkpoint.implementerSessionId).toBe("session-impl-1")
      expect(checkpoint.reviewerSessionId).toBe("session-reviewer-1")
      expect(checkpoint.sessionBaseUrl).toBe("http://127.0.0.1:12345")
      // v3 must NOT contain legacy pane ID fields
      expect((checkpoint as Record<string, unknown>).implementerPane).toBeUndefined()
      expect((checkpoint as Record<string, unknown>).reviewerPane).toBeUndefined()
    } finally {
      await rm(dir, { force: true, recursive: true })
    }
  })

  it("round-trips all metadata fields needed for resume", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mini-orch-checkpoint-roundtrip-"))
    try {
      const input = sampleInput({
        cannotVerifySummary: "cannot verify auth token flow",
        reuseCurrentPane: true,
        round: 3,
      })
      const filePath = await writeNeedsCheckCheckpoint(dir, input)
      const checkpoint = await readNeedsCheckCheckpoint(filePath)

      expect(checkpoint.baseSha).toBe("abc123")
      expect(checkpoint.cannotVerifySummary).toBe("cannot verify auth token flow")
      expect(checkpoint.configPath).toBe("/tmp/workflow.json")
      expect(checkpoint.hasGit).toBe(true)
      expect(checkpoint.maxReviewRounds).toBe(4)
      expect(checkpoint.reviewOutput).toBe("REVIEW_NEEDS_CHECK: needs human verification")
      expect(checkpoint.reuseCurrentPane).toBe(true)
      expect(checkpoint.round).toBe(3)
      expect(checkpoint.currentIssueIndex).toBe(0)
      expect(checkpoint.issues).toEqual([{ title: "Add login", specPath: "/tmp/spec.md" }])
      expect(checkpoint.createdAt).toBeTruthy()
      expect(checkpoint.version).toBe(CHECKPOINT_VERSION)
    } finally {
      await rm(dir, { force: true, recursive: true })
    }
  })

  it("rejects an old v2 checkpoint with a clear, actionable error message", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mini-orch-checkpoint-v2-reject-"))
    try {
      const v2Checkpoint = {
        baseSha: "abc123",
        cannotVerifySummary: null,
        configPath: "/tmp/workflow.json",
        createdAt: new Date().toISOString(),
        hasGit: true,
        implementerPane: "pane-impl",
        maxReviewRounds: 4,
        projectDir: "/tmp/project",
        reviewOutput: "REVIEW_NEEDS_CHECK",
        reviewerPane: "pane-reviewer",
        reuseCurrentPane: false,
        round: 2,
        version: 2,
        currentIssueIndex: 0,
        issues: [{ title: "Fix", specPath: "/tmp/spec.md" }],
      }
      const filePath = path.join(dir, "v2-checkpoint.json")
      await writeFile(filePath, JSON.stringify(v2Checkpoint, null, 2), "utf8")

      await expect(readNeedsCheckCheckpoint(filePath)).rejects.toThrow(
        /checkpoint version 2/i,
      )
      await expect(readNeedsCheckCheckpoint(filePath)).rejects.toThrow(
        /mini-orch/i,
      )
    } finally {
      await rm(dir, { force: true, recursive: true })
    }
  })

  it("rejects a future version with a clear error", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mini-orch-checkpoint-future-"))
    try {
      const future = { ...sampleInput(), createdAt: new Date().toISOString(), version: 99 }
      const filePath = path.join(dir, "future-checkpoint.json")
      await writeFile(filePath, JSON.stringify(future, null, 2), "utf8")

      await expect(readNeedsCheckCheckpoint(filePath)).rejects.toThrow(
        /checkpoint version.*99/i,
      )
    } finally {
      await rm(dir, { force: true, recursive: true })
    }
  })
})
