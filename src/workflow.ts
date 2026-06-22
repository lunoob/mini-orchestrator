import path from "node:path"

import { isFlagEnabled } from "./cli.js"
import { loadConfig, loadImplementSkills, loadPrompts, loadReviseSkills } from "./config.js"
import { getHeadSha, isGitRepo } from "./git.js"
import type { ParsedArgs } from "./types.js"
import {
  getCurrentPane,
  readAgentOutput,
  sendTask,
  startAgent,
  waitForIdle,
} from "./herdr.js"
import { generateReviewPackage } from "./review-package.js"
import { parseReviewVerdict, printSection, render } from "./utils.js"

const buildDiffFileSection = (diffFile: string | undefined) => {
  if (!diffFile) {
    return [
      "",
      "（未生成 diff 文件——项目可能不是 git 仓库。请审查工作区改动，并阅读 `task_plan.md` / `progress.md`。）",
    ].join("\n")
  }

  return ["", `**Diff 文件（先读此文件）：** ${diffFile}`].join("\n")
}

const prepareReviewContext = async (
  projectDir: string,
  baseSha: string | undefined,
  round: number,
) => {
  if (!baseSha || !(await isGitRepo(projectDir))) {
    return { baseSha: "N/A", diffFile: undefined, headSha: "N/A" }
  }

  const headSha = await getHeadSha(projectDir)
  const diffFile = await generateReviewPackage(projectDir, baseSha, headSha, round)
  return { baseSha, diffFile, headSha }
}

export const runWorkflow = async (args: ParsedArgs) => {
  const configPath = path.resolve(args.config)
  const config = await loadConfig(configPath, args)
  const prompts = await loadPrompts(config, path.dirname(configPath))
  const implementSkills = await loadImplementSkills(config, path.dirname(configPath))
  const reviseSkills = await loadReviseSkills(config, path.dirname(configPath))

  const reuseCurrentPane = isFlagEnabled(args, "reuse-current-pane")

  const hasGit = await isGitRepo(config.projectDir)
  const baseSha = hasGit ? await getHeadSha(config.projectDir) : undefined
  if (baseSha) {
    console.log(`Review baseline: ${baseSha}`)
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
        diffFileSection: buildDiffFileSection(reviewContext.diffFile),
        headSha: reviewContext.headSha,
        round: String(round),
        specPath: config.specPath,
      }),
    )
    await waitForIdle(reviewerPane)

    const reviewOutput = await readAgentOutput(reviewerPane, 280)
    printSection(`Review Round ${round}`, reviewOutput)

    const verdict = parseReviewVerdict(reviewOutput)
    if (verdict.passed) {
      console.log(`\nWorkflow finished: review passed in round ${round}.`)
      if (verdict.specCompliant !== null || verdict.qualityApproved !== null) {
        console.log(
          `Verdict: spec=${verdict.specCompliant ? "✅" : "—"}, quality=${verdict.qualityApproved ? "Approved" : "—"}`,
        )
      }
      return
    }

    if (round === config.maxReviewRounds) {
      throw new Error(`Review failed after ${config.maxReviewRounds} rounds.`)
    }

    if (verdict.hasBlockingIssues) {
      console.log("Blocking issues (Critical/Important) — sending back to implementer.")
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
