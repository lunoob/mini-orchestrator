import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

import { runGitCommand } from "./git.js"

export const generateReviewPackage = async (
  projectDir: string,
  baseSha: string,
  headSha: string,
  round: number,
) => {
  const dir = path.join(projectDir, ".orchestrator")
  await mkdir(dir, { recursive: true })

  const filePath = path.join(dir, `review-round-${round}-${Date.now()}.md`)
  const sections: string[] = [
    `# Review Package — Round ${round}`,
    "",
    `Base: ${baseSha}`,
    `Head: ${headSha}`,
    "",
  ]

  const log = await runGitCommand(projectDir, ["log", "--oneline", `${baseSha}..${headSha}`])
  sections.push("## Commits", "", log || "(no commits in range)", "")

  const stat = await runGitCommand(projectDir, ["diff", "--stat", `${baseSha}..${headSha}`])
  sections.push("## Diff Stat", "", "```", stat || "(empty)", "```", "")

  const diff = await runGitCommand(projectDir, ["diff", "-U10", `${baseSha}..${headSha}`])
  sections.push("## Diff", "", "```diff", diff || "(empty)", "```", "")

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
