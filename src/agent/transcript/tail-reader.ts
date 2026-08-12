import { open } from "node:fs/promises"
import { StringDecoder } from "node:string_decoder"
import type { FileHandle } from "node:fs/promises"

export type TailReadResult = {
  events: unknown[]
  /** 下次读取的字节偏移 */
  nextOffset: number
}

export type JsonlTailReader = {
  readNewLines: (fromByteOffset: number) => Promise<TailReadResult>
  close: () => Promise<void>
}

/**
 * 创建 JSONL 增量读取器。
 *
 * 使用字节偏移（byte position）增量读取。
 * StringDecoder 处理跨批次 UTF-8 多字节字符边界。
 * 半行缓存在 pendingPartial 中，下一批读取时拼接。
 */
export const createJsonlTailReader = (filePath: string): JsonlTailReader => {
  let fileHandle: FileHandle | undefined
  let pendingPartial = ""
  const decoder = new StringDecoder("utf8")

  const ensureHandle = async (): Promise<FileHandle | undefined> => {
    try {
      if (!fileHandle) {
        fileHandle = await open(filePath, "r")
      }
      return fileHandle
    } catch {
      return undefined
    }
  }

  const close = async () => {
    if (fileHandle) {
      await fileHandle.close()
      fileHandle = undefined
    }
  }

  return {
    readNewLines: async (fromByteOffset: number) => {
      const handle = await ensureHandle()
      if (!handle) return { events: [], nextOffset: fromByteOffset }

      const stat = await handle.stat()
      if (stat.size <= fromByteOffset) {
        if (stat.size === 0) pendingPartial = ""
        return { events: [], nextOffset: fromByteOffset }
      }

      const newBytesSize = stat.size - fromByteOffset
      const buffer = Buffer.alloc(newBytesSize)
      const { bytesRead } = await handle.read(buffer, 0, newBytesSize, fromByteOffset)

      if (bytesRead === 0) return { events: [], nextOffset: fromByteOffset }

      // StringDecoder 自动处理跨批次 UTF-8 边界（缓存未完整字节）
      const newText = decoder.write(buffer.subarray(0, bytesRead))
      const fullText = pendingPartial + newText

      const lines = fullText.split("\n")
      const hasTrailingNewline = fullText.endsWith("\n")

      let completeLines: string[]
      if (hasTrailingNewline) {
        completeLines = lines.slice(0, -1)
        pendingPartial = ""
      } else {
        completeLines = lines.slice(0, -1)
        pendingPartial = lines[lines.length - 1]
      }

      const consumedBytes = bytesRead

      const events: unknown[] = []
      for (const line of completeLines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          events.push(JSON.parse(trimmed))
        } catch {
          // 跳过非 JSON 行
        }
      }

      return { events, nextOffset: fromByteOffset + consumedBytes }
    },
    close,
  }
}
