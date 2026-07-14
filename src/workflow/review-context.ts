import { getHeadShaSafe, isGitRepo } from "../git/index.js"
import { generateReviewPackage } from "../review/package.js"
import type { WorkflowRuntime } from "./types.js"

export const buildDiffFileSection = (diffFile: string | undefined, noGit: boolean) => {
  if (!diffFile) {
    const reason = noGit
      ? "项目不是 git 仓库"
      : "无可用 commit 范围或无法生成 diff"
    return [
      "",
      `（未生成 diff 文件——${reason}。请审查工作区改动与实现记录。）`,
    ].join("\n")
  }

  return ["", `**Diff 文件（先读此文件）：** ${diffFile}`].join("\n")
}

export const formatBaselineLabel = (baseSha: string | undefined) =>
  baseSha ?? "(workflow start — no commits yet)"

export const prepareReviewContext = async (
  sessionDir: string,
  projectDir: string,
  baseSha: string | undefined,
  round: number,
) => {
  if (!(await isGitRepo(projectDir))) {
    return { baseSha: "N/A", diffFile: undefined, headSha: "N/A" }
  }

  const headSha = await getHeadShaSafe(projectDir)
  const diffFile = await generateReviewPackage(sessionDir, projectDir, baseSha, headSha, round)
  return {
    baseSha: formatBaselineLabel(baseSha),
    diffFile,
    headSha: headSha ?? "N/A",
  }
}

export const advanceBaseline = async (runtime: WorkflowRuntime) => {
  if (!runtime.hasGit) return
  const headSha = await getHeadShaSafe(runtime.config.projectDir)
  if (headSha) {
    runtime.baseSha = headSha
    console.log(`[Baseline] Review baseline advanced: ${headSha}`)
  }
}
