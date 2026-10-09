type SessionIdentity = {
  resumeId: string
  jsonl: string
}

type ReadinessOptions = {
  read: (paneId: string, lines: number) => Promise<string>
  sleep?: (ms: number) => Promise<void>
}

const READY_ATTEMPTS = 6
const READY_WAIT_MS = 5_000
const READ_LINES = 280

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

const normalizeForMatch = (value: string) => value.replace(/\s+/g, "")

const getMatchResult = (output: string, session: SessionIdentity) => {
  const normalizedOutput = normalizeForMatch(output)
  return {
    resumeId: normalizedOutput.includes(normalizeForMatch(session.resumeId)),
    jsonl: normalizedOutput.includes(normalizeForMatch(session.jsonl)),
  }
}

export const waitForAgentReady = async (
  paneId: string, session: SessionIdentity, options: ReadinessOptions,
) => {
  const sleep = options.sleep ?? defaultSleep
  let latestOutput = ""
  let latestMatch = { resumeId: false, jsonl: false }

  for (let attempt = 0; attempt < READY_ATTEMPTS; attempt += 1) {
    await sleep(READY_WAIT_MS)

    try {
      const output = await options.read(paneId, READ_LINES)
      latestOutput = output
      latestMatch = getMatchResult(output, session)
      if (latestMatch.resumeId && latestMatch.jsonl) return
    } catch {
      // Herdr 读取异常也计入本次尝试，避免短暂的读取失败提前终止启动流程。
    }
  }

  const matchDetail = `\nMatch: resumeId=${latestMatch.resumeId}, jsonl=${latestMatch.jsonl}`
  const outputDetail = latestOutput ? `\nPane output:\n${latestOutput}` : ""
  throw new Error(`Agent CLI 启动失败${matchDetail}${outputDetail}`)
}
