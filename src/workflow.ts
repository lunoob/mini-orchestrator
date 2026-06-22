import path from "node:path"

import { isFlagEnabled } from "./cli.js"
import { loadConfig, loadImplementSkills, loadPrompts, loadReviseSkills } from "./config.js"
import { getHeadShaSafe, getReviewBaselineSha, isGitRepo } from "./git.js"
import type { ParsedArgs } from "./types.js"
import {
  getCurrentPane,
  readAgentOutput,
  sendTask,
  startAgent,
  waitForIdle,
} from "./herdr.js"
import { generateReviewPackage } from "./review-package.js"
import { parseReviewVerdict, printSection, render, type ReviewVerdict } from "./utils.js"

const buildDiffFileSection = (diffFile: string | undefined, noGit: boolean) => {
  if (!diffFile) {
    const reason = noGit
      ? "项目不是 git 仓库"
      : "无可用 commit 范围或无法生成 diff"
    return [
      "",
      `（未生成 diff 文件——${reason}。请审查工作区改动，并阅读 \`task_plan.md\` / \`progress.md\`。）`,
    ].join("\n")
  }

  return ["", `**Diff 文件（先读此文件）：** ${diffFile}`].join("\n")
}

const formatBaselineLabel = (baseSha: string | undefined) =>
  baseSha ?? "(workflow start — no commits yet)"

const prepareReviewContext = async (
  projectDir: string,
  baseSha: string | undefined,
  round: number,
) => {
  if (!(await isGitRepo(projectDir))) {
    return { baseSha: "N/A", diffFile: undefined, headSha: "N/A" }
  }

  const headSha = await getHeadShaSafe(projectDir)
  const diffFile = await generateReviewPackage(projectDir, baseSha, headSha, round)
  return {
    baseSha: formatBaselineLabel(baseSha),
    diffFile,
    headSha: headSha ?? "N/A",
  }
}

const throwNeedsCheck = (round: number, verdict: ReviewVerdict, reviewOutput: string) => {
  const lines = [
    `Review needs human/controller check in round ${round}.`,
    "Reviewer could not verify some items from diff alone — this is not an implementer fix request.",
  ]

  if (verdict.cannotVerifySummary) {
    lines.push("", "Cannot verify:", verdict.cannotVerifySummary)
  }

  lines.push("", "Full review output:", reviewOutput.trim())

  throw new Error(lines.join("\n"))
}

export const runWorkflow = async (args: ParsedArgs) => {
  const configPath = path.resolve(args.config)
  const config = await loadConfig(configPath, args)
  const prompts = await loadPrompts(config, path.dirname(configPath))
  const implementSkills = await loadImplementSkills(config, path.dirname(configPath))
  const reviseSkills = await loadReviseSkills(config, path.dirname(configPath))

  const reuseCurrentPane = isFlagEnabled(args, "reuse-current-pane")

  const hasGit = await isGitRepo(config.projectDir)
  const baseSha = await getReviewBaselineSha(config.projectDir)
  if (baseSha) {
    console.log(`Review baseline: ${baseSha}`)
  } else if (hasGit) {
    console.log("Review baseline: (no commits yet — will diff from repo start after implement)")
  } else {
    console.log("Review baseline: (not a git repo)")
  }

  const implementerPane = await startAgent(config.projectDir, config.implementer)
  const reviewerPane = reuseCurrentPane
    ? await getCurrentPane()
    : await startAgent(config.projectDir, config.reviewer)

  if (reuseCurrentPane) {
    console.log(`Reusing current pane as reviewer: ${reviewerPane}`)
  }

  await sendTask(
    implementerPane,
    render(prompts.implement, {
      implementSkills,
      maxReviewRounds: String(config.maxReviewRounds),
      specPath: config.specPath,
    }),
  )
  await waitForIdle(implementerPane)

  for (let round = 1; round <= config.maxReviewRounds; round += 1) {
    const reviewContext = await prepareReviewContext(config.projectDir, baseSha, round)
    if (reviewContext.diffFile) {
      console.log(`Review package: ${reviewContext.diffFile}`)
    }

    await sendTask(
      reviewerPane,
      render(prompts.review, {
        baseSha: reviewContext.baseSha,
        diffFileSection: buildDiffFileSection(reviewContext.diffFile, !hasGit),
        headSha: reviewContext.headSha,
        round: String(round),
        specPath: config.specPath,
      }),
    )
    await waitForIdle(reviewerPane)

    const reviewOutput = await readAgentOutput(reviewerPane, 280)
    printSection(`Review Round ${round}`, reviewOutput)

    const verdict = parseReviewVerdict(reviewOutput)

    if (verdict.kind === "pass") {
      console.log(`\nWorkflow finished: review passed in round ${round}.`)
      if (verdict.specCompliant !== null || verdict.qualityApproved !== null) {
        console.log(
          `Verdict: spec=${verdict.specCompliant ? "✅" : "—"}, quality=${verdict.qualityApproved ? "Approved" : "—"}`,
        )
      }
      return
    }

    if (verdict.kind === "needs_check") {
      throwNeedsCheck(round, verdict, reviewOutput)
    }

    if (round === config.maxReviewRounds) {
      throw new Error(`Review failed after ${config.maxReviewRounds} rounds.`)
    }

    if (verdict.hasBlockingIssues) {
      console.log("Blocking issues (Critical/Important) — sending back to implementer.")
    } else {
      console.log("Review failed — sending back to implementer.")
    }

    await sendTask(
      implementerPane,
      render(prompts.revise, {
        reviewOutput,
        reviseSkills,
        round: String(round),
      }),
    )
    await waitForIdle(implementerPane)
  }
}
