import { describe, expect, it } from "vitest"

import { executeRelease } from "./workflow.js"

describe("executeRelease", () => {
  it("runs git and GitHub release only after npm publish succeeds", async () => {
    const events: string[] = []

    await executeRelease({
      prepare: async () => {
        events.push("prepare")
        return "0.1.8"
      },
      publish: async () => {
        events.push("publish")
      },
      finalizeGit: async () => {
        events.push("git")
      },
      releaseGithub: async () => {
        events.push("github")
      },
    })

    expect(events).toEqual(["prepare", "publish", "git", "github"])
  })

  it("does not finalize when npm publish fails", async () => {
    const events: string[] = []

    await expect(
      executeRelease({
        prepare: async () => {
          events.push("prepare")
          return "0.1.8"
        },
        publish: async () => {
          events.push("publish")
          throw new Error("npm publish failed")
        },
        finalizeGit: async () => {
          events.push("git")
        },
        releaseGithub: async () => {
          events.push("github")
        },
      }),
    ).rejects.toThrow("npm publish failed")

    expect(events).toEqual(["prepare", "publish"])
  })

  it("does not create a GitHub release when git finalization fails", async () => {
    const events: string[] = []

    await expect(
      executeRelease({
        prepare: async () => "0.1.8",
        publish: async () => {
          events.push("publish")
        },
        finalizeGit: async () => {
          events.push("git")
          throw new Error("git finalization failed")
        },
        releaseGithub: async () => {
          events.push("github")
        },
      }),
    ).rejects.toThrow("git finalization failed")

    expect(events).toEqual(["publish", "git"])
  })
})
