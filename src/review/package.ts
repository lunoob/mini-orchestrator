import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

import { GIT_EMPTY_TREE_SHA, runGitCommand } from "../git/index.js"

/** 未跟踪文件章节中排除的非源码路径段（构建产物、运行痕迹等） */
const EXCLUDED_UNTRAKED_DIRS = new Set([".git", ".orchestrator", "node_modules", "dist", "build", "coverage"])

const isExcludedUntrackedFile = (file: string) =>
  file.split("/").some((segment) => EXCLUDED_UNTRAKED_DIRS.has(segment))

/**
 * 未跟踪文件（?? 状态）不在 git diff 中，列出完整内容供审查。
 * git ls-files --exclude-standard 已尊重 .gitignore（构建产物默认被排除），
 * 这里再显式排除 .orchestrator 等运行痕迹目录。源码文件不按大小截断，
 * 保证完整 diff package 覆盖所有未跟踪源码；仅二进制文件（NUL 检测）不展开。
 */
const buildUntrackedSection = async (projectDir: string): Promise<string[]> => {
  const raw = await runGitCommand(projectDir, ["ls-files", "--others", "--exclude-standard"])
  const files = raw.split("\n").filter((file) => file && !isExcludedUntrackedFile(file))
  if (files.length === 0) return []

  const sections: string[] = [
    "## Untracked Files",
    "",
    "以下未跟踪文件不在 git diff 中，列出完整内容供审查：",
    "",
  ]

  for (const file of files) {
    const buf = await readFile(path.join(projectDir, file)).catch(() => undefined)
    if (!buf) continue
    if (buf.includes(0)) {
      sections.push(`### ${file} (skipped: binary file)`, "")
      continue
    }
    sections.push(`### ${file}`, "", "```", buf.toString("utf8"), "```", "")
  }

  return sections
}

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

  // 未跟踪源码不在 git diff 中，补充完整内容（排除构建产物与运行痕迹目录）
  sections.push(...(await buildUntrackedSection(projectDir)))

  await writeFile(filePath, sections.join("\n"), "utf8")
  return filePath
}
