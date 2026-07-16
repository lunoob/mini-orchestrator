import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import os from "node:os"
import { describe, expect, it } from "vitest"

import { markIssueFinished, markIssueInReview } from "./persist.js"
import type { IssueConfig } from "../types.js"

const writeConfig = (dir: string, data: Record<string, unknown>) => {
  const configPath = path.join(dir, "workflow.json")
  writeFileSync(configPath, JSON.stringify(data, null, 2), "utf8")
  return configPath
}

describe("markIssueFinished", () => {
  it("writes state=finish for the issue at index and syncs memory", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "persist-test-"))
    const configPath = writeConfig(dir, {
      projectDir: dir,
      issues: [
        { title: "One", specPath: "/a.md", state: "ready" },
        { title: "Two", specPath: "/b.md" },
      ],
      maxReviewRounds: 4,
    })
    const issues: IssueConfig[] = [
      { title: "One", specPath: "/a.md", state: "ready" },
      { title: "Two", specPath: "/b.md", state: "ready" },
    ]

    await markIssueFinished(configPath, 0, issues)

    const saved = JSON.parse(readFileSync(configPath, "utf8"))
    expect(saved.issues[0].state).toBe("finish")
    expect(saved.issues[1].state).toBeUndefined()
    expect(saved.issues[0].title).toBe("One")
    expect(issues[0].state).toBe("finish")
    expect(issues[1].state).toBe("ready")
  })

  it("throws if issue index is out of range", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "persist-test-"))
    const configPath = writeConfig(dir, {
      issues: [{ title: "One", specPath: "/a.md" }],
    })

    await expect(markIssueFinished(configPath, 3)).rejects.toThrow(/issues\[3\]/)
  })
})

describe("markIssueInReview", () => {
  it("writes state=review for the issue at index and syncs memory", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "persist-test-"))
    const configPath = writeConfig(dir, {
      projectDir: dir,
      issues: [
        { title: "One", specPath: "/a.md", state: "ready" },
        { title: "Two", specPath: "/b.md", state: "review" },
      ],
      maxReviewRounds: 4,
    })
    const issues: IssueConfig[] = [
      { title: "One", specPath: "/a.md", state: "ready" },
      { title: "Two", specPath: "/b.md", state: "review" },
    ]

    await markIssueInReview(configPath, 0, issues)

    const saved = JSON.parse(readFileSync(configPath, "utf8"))
    expect(saved.issues[0].state).toBe("review")
    expect(saved.issues[1].state).toBe("review")
    expect(issues[0].state).toBe("review")
    expect(issues[1].state).toBe("review")
  })
})
