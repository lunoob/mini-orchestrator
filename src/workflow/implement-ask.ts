import { createInterface } from "node:readline/promises"
import { stdin as input, stdout as output } from "node:process"

import { readAgentOutput, waitForIdle } from "../agent/index.js"
import { extractImplementResult, parseImplementStatus } from "../lib/utils.js"

/** 用户在 IMPLEMENT_ASK 交互中选择 no：正常中止，非故障 */
export class ImplementAskAbortError extends Error {
  constructor(context: string) {
    super(`用户取消继续（${context}）`)
    this.name = "ImplementAskAbortError"
  }
}

export type ImplementAskDeps = {
  log: (message: string) => void
  promptContinue: () => Promise<boolean>
  readOutput: (paneId: string) => Promise<string>
  waitAfterContinue: (paneId: string) => Promise<void>
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

export const defaultImplementAskDeps = (): ImplementAskDeps => ({
  log: (message) => console.log(message),
  promptContinue: promptContinueInteractive,
  // 与 sendTaskAndWait 后半段一致：等 idle/done，再读输出；ASK 路径不设总超时
  waitAfterContinue: (paneId) => waitForIdle(paneId, { timeoutMs: null }),
  readOutput: (paneId) => readAgentOutput(paneId, 280),
})

/**
 * 若 output 为 IMPLEMENT_ASK：提示用户去 pane 确认，交互 yes/no。
 * yes → 无超时等待 implementer 再次完成并读输出；仍为 ASK 则循环。
 * no → 抛 ImplementAskAbortError（上层应正常退出）。
 */
export const handleImplementAskIfNeeded = async (
  paneId: string,
  output: string,
  context: string,
  deps: ImplementAskDeps = defaultImplementAskDeps(),
): Promise<string> => {
  let current = output

  while (parseImplementStatus(extractImplementResult(current)) === "needs_input") {
    // 不打印 implementer 全文，避免把问答细节刷进编排日志
    deps.log(
      `[ImplementAsk] implementer 有问题需要确认（${context}）。` +
        "可在 implementer 侧继续交互，完成后选择是否继续。",
    )

    const shouldContinue = await deps.promptContinue()
    if (!shouldContinue) throw new ImplementAskAbortError(context)

    await deps.waitAfterContinue(paneId)
    current = await deps.readOutput(paneId)
  }

  return current
}
