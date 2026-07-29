import { createInterface } from "node:readline/promises"
import { stdin as input, stdout as output } from "node:process"

import { extractImplementResult, parseImplementStatus } from "../lib/utils.js"
import { notifyImplementAsk } from "../notify/index.js"

/** 用户在 IMPLEMENT_ASK 交互中选择 no：正常中止，非故障 */
export class ImplementAskAbortError extends Error {
  constructor(context: string) {
    super(`用户取消继续（${context}）`)
    this.name = "ImplementAskAbortError"
  }
}

const promptContinueInteractive = async (): Promise<boolean> => {
  const rl = createInterface({ input, output })

  try {
    while (true) {
      const answer = (await rl.question("implementer 需要确认，是否继续？[yes / no]: "))
        .trim()
        .toLowerCase()

      if (answer === "yes" || answer === "y") return true
      if (answer === "no" || answer === "n") return false
      console.log("[ImplementAsk] 无效输入，请输入：yes / no")
    }
  } finally {
    rl.close()
  }
}

export type ImplementAskDeps = {
  log: (message: string) => void
  promptContinue: () => Promise<boolean>
}

export const defaultImplementAskDeps = (): ImplementAskDeps => ({
  log: (message) => console.log(message),
  promptContinue: promptContinueInteractive,
})

/**
 * Session 版 IMPLEMENT_ASK 处理。
 * 若 output 为 IMPLEMENT_ASK → 提示用户后通过 continueTask 在同一个 session 中继续等待。
 * yes → 调用 continueTask 等待下一次完成；仍为 ASK 则循环。
 * no → 抛 ImplementAskAbortError（上层应正常退出）。
 */
export const handleSessionImplementAskIfNeeded = async (
  output: string,
  context: string,
  continueTask: () => Promise<string>,
  deps: Pick<ImplementAskDeps, "log" | "promptContinue"> = defaultImplementAskDeps(),
) => {
  let current = output

  while (parseImplementStatus(extractImplementResult(current)) === "needs_input") {
    deps.log(
      `[ImplementAsk] implementer 有问题需要确认（${context}）。` +
        "可在 implementer 侧继续交互，完成后选择是否继续。",
    )
    notifyImplementAsk()
    if (!await deps.promptContinue()) throw new ImplementAskAbortError(context)
    current = await continueTask()
  }

  return current
}
