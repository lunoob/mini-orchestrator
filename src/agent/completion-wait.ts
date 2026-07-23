import {
  IMPLEMENT_RESULT_END,
  IMPLEMENT_RESULT_START,
  REVIEW_RESULT_END,
  REVIEW_RESULT_START,
} from "../lib/prompt-delimiters.js"

const INITIAL_TIMEOUT_MS = 3_600_000
const FALLBACK_TIMEOUT_MS = 600_000
const STABILITY_DELAY_MS = 5_000
const LEGAL_STATUSES = new Set([
  "IMPLEMENT_DONE",
  "IMPLEMENT_ASK",
  "REVIEW_PASS",
  "REVIEW_FAIL",
  "REVIEW_NEEDS_CHECK",
])

type ResultDelimiter = {
  end: string
  start: string
}

const resultDelimiters: ResultDelimiter[] = [
  { end: IMPLEMENT_RESULT_END, start: IMPLEMENT_RESULT_START },
  { end: REVIEW_RESULT_END, start: REVIEW_RESULT_START },
]

export type CompletionWaitDeps = {
  log: (message: string) => void
  readOutput: () => Promise<string>
  sleep: (ms: number) => Promise<void>
  waitForStatus: (timeoutMs: number) => Promise<void>
}

const latestResultBlock = (output: string) => {
  const latest = resultDelimiters
    .map((delimiter) => ({ delimiter, startIndex: output.lastIndexOf(delimiter.start) }))
    .reduce<{ delimiter: ResultDelimiter; startIndex: number } | undefined>(
      (current, candidate) => candidate.startIndex > (current?.startIndex ?? -1) ? candidate : current,
      undefined,
    )

  if (!latest || latest.startIndex === -1) return

  const endIndex = output.indexOf(latest.delimiter.end, latest.startIndex + latest.delimiter.start.length)
  if (endIndex === -1) return

  return output.slice(latest.startIndex, endIndex + latest.delimiter.end.length)
}

const hasLegalStatus = (block: string) =>
  [...LEGAL_STATUSES].some((status) => new RegExp(`^[ \\t]*STATUS: ${status}$`, "m").test(block))

const stableFinalBlock = (firstOutput: string, secondOutput: string) => {
  const firstBlock = latestResultBlock(firstOutput)
  const secondBlock = latestResultBlock(secondOutput)
  if (!firstBlock || !secondBlock || firstBlock !== secondBlock) return false
  return hasLegalStatus(secondBlock)
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Herdr 可能漏报终态；仅在最终结果块稳定时才以输出作为完成信号。 */
export const waitForCompletionWithFallback = async (
  paneId: string,
  deps: CompletionWaitDeps,
): Promise<string | undefined> => {
  let timeoutMs = INITIAL_TIMEOUT_MS

  while (true) {
    try {
      await deps.waitForStatus(timeoutMs)
      return
    } catch {
      deps.log(
        `[Agent] Pane ${paneId} 等待 idle/done 已超时（${timeoutMs}ms），正在使用输出稳定性兜底检查。`,
      )
      const firstOutput = await deps.readOutput()
      await deps.sleep(STABILITY_DELAY_MS)
      const secondOutput = await deps.readOutput()
      if (stableFinalBlock(firstOutput, secondOutput)) return secondOutput

      // 一旦 Herdr 已漏报过终态，缩短后续等待以更快重试输出稳定性检查。
      timeoutMs = FALLBACK_TIMEOUT_MS
    }
  }
}
