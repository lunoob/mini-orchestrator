import path from "node:path"

import { isFlagEnabled } from "./cli.js"
import { loadConfig, loadImplementSkills, loadPrompts } from "./config.js"
import type { ParsedArgs } from "./types.js"
import {
  getCurrentPane,
  readAgentOutput,
  sendTask,
  startAgent,
  waitForIdle,
} from "./herdr.js"
import { hasStatus, printSection, render } from "./utils.js"

export const runWorkflow = async (args: ParsedArgs) => {
  const configPath = path.resolve(args.config)
  const config = await loadConfig(configPath, args)
  const prompts = await loadPrompts(config, path.dirname(configPath))
  const implementSkills = await loadImplementSkills(config, path.dirname(configPath))

  const reuseCurrentPane = isFlagEnabled(args, "reuse-current-pane")

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
    await sendTask(reviewerPane, render(prompts.review, { round: String(round) }))
    await waitForIdle(reviewerPane)

    const reviewOutput = await readAgentOutput(reviewerPane, 220)
    printSection(`Review Round ${round}`, reviewOutput)

    if (hasStatus(reviewOutput, "REVIEW_PASS")) {
      console.log(`\nWorkflow finished: review passed in round ${round}.`)
      return
    }

    if (round === config.maxReviewRounds) {
      throw new Error(`Review failed after ${config.maxReviewRounds} rounds.`)
    }

    await sendTask(
      implementerPane,
      render(prompts.revise, {
        round: String(round),
        reviewOutput,
      }),
    )
    await waitForIdle(implementerPane)
  }
}
