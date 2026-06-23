import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

import { GIT_EMPTY_TREE_SHA, runGitCommand } from "./git.js"

export const generateReviewPackage = async (
  dir: string,
  projectDir: string,
  baseSha: string | undefined,
  headSha: string | undefined,
  round: number,
) => {
  await mkdir(dir, { recursive: true })

  const filePath = path.join(dir, `review-round-${round}-${Date.now()}.md`)
  const baseLabel = baseSha ?? "(workflow start — no commits yet)"
  const headLabel = headSha ?? "(no HEAD)"
  const sections: string[] = [
    `# Review Package — Round ${round}`,
    "",
    `Base: ${baseLabel}`,
    `Head: ${headLabel}`,
    "",
  ]

  if (headSha) {
    const effectiveBase = baseSha ?? GIT_EMPTY_TREE_SHA
    const range = `${effectiveBase}..${headSha}`

    const log = await runGitCommand(projectDir, ["log", "--oneline", range])
    sections.push("## Commits", "", log || "(no commits in range)", "")

    const stat = await runGitCommand(projectDir, ["diff", "--stat", range])
    sections.push("## Diff Stat", "", "```", stat || "(empty)", "```", "")

    const diff = await runGitCommand(projectDir, ["diff", "-U10", range])
    sections.push("## Diff", "", "```diff", diff || "(empty)", "```", "")
  } else {
    sections.push(
      "## Commits",
      "",
      "(no commits — implementer may have only uncommitted changes)",
      "",
    )
  }

  const status = await runGitCommand(projectDir, ["status", "--porcelain"])
  if (status) {
    const wtStat = await runGitCommand(projectDir, ["diff", "--stat"])
    const wtDiff = await runGitCommand(projectDir, ["diff", "-U10"])
    const stagedStat = await runGitCommand(projectDir, ["diff", "--cached", "--stat"])
    const stagedDiff = await runGitCommand(projectDir, ["diff", "--cached", "-U10"])

    sections.push("## Uncommitted Changes", "", `Status:\n${status}`, "")

    if (wtStat) {
      sections.push("### Working Tree Stat", "", "```", wtStat, "```", "")
    }
    if (wtDiff) {
      sections.push("### Working Tree Diff", "", "```diff", wtDiff, "```", "")
    }
    if (stagedStat) {
      sections.push("### Staged Stat", "", "```", stagedStat, "```", "")
    }
    if (stagedDiff) {
      sections.push("### Staged Diff", "", "```diff", stagedDiff, "```", "")
    }
  }

  await writeFile(filePath, sections.join("\n"), "utf8")
  return filePath
}
