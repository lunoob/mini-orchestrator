const JSONL_READY_WAIT_MS = 15_000
const JSONL_POLL_MS = 500
const JSONL_WAIT_ATTEMPTS = 3

/**
 * 等待 JSONL 文件就绪：每个周期最多 waitMs，至多 attempts 个周期。
 * 会话已建立，只对同一 jsonl 续等，不重建会话。
 */
export const waitForJsonlReady = async (
  jsonlPath: string, agentName: string,
  options: { attempts?: number; waitMs?: number; pollMs?: number } = {},
): Promise<number> => {
  const attempts = options.attempts ?? JSONL_WAIT_ATTEMPTS
  const waitMs = options.waitMs ?? JSONL_READY_WAIT_MS
  const pollMs = options.pollMs ?? JSONL_POLL_MS
  const { open } = await import("node:fs/promises")

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const deadline = Date.now() + waitMs

    while (Date.now() < deadline) {
      try {
        const fh = await open(jsonlPath, "r")
        const stat = await fh.stat()
        if (stat.size > 0) {
          const buffer = Buffer.alloc(stat.size)
          const { bytesRead } = await fh.read(buffer, 0, stat.size, 0)
          if (buffer.toString("utf8", 0, bytesRead).includes("\n")) {
            await fh.close()
            return stat.size
          }
        }
        await fh.close()
      } catch { /* JSONL not ready */ }
      await new Promise((r) => setTimeout(r, pollMs))
    }

    if (attempt < attempts) {
      console.log(
        `[Agent] JSONL not ready for "${agentName}" after attempt ${attempt}/${attempts}, keeping waiting...`,
      )
    }
  }

  throw new Error(
    `[Agent] Bootstrap failed for "${agentName}": JSONL not ready within ${waitMs * attempts}ms: ${jsonlPath}`,
  )
}
