import { describe, expect, it } from "vitest"
import { appendFile, readFile, writeFile } from "node:fs/promises"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { createJsonlTailReader, type JsonlTailReader } from "./tail-reader.js"

// 每个测试使用独立临时文件，避免并行冲突
const tmpFile = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mini-orch-tail-"))
  return path.join(dir, "session.jsonl")
}

const writeJsonl = async (filePath: string, lines: string[]) => {
  await writeFile(filePath, lines.join("\n") + (lines.length > 0 ? "\n" : ""), "utf8")
}

describe("createJsonlTailReader", () => {
  it("returns parsed lines from offset 0", async () => {
    const filePath = tmpFile()
    await writeJsonl(filePath, [
      JSON.stringify({ type: "event", seq: 1 }),
      JSON.stringify({ type: "event", seq: 2 }),
    ])

    const reader = createJsonlTailReader(filePath)
    const result = await reader.readNewLines(0)

    expect(result.events).toHaveLength(2)
    expect(result.events[0]).toEqual({ type: "event", seq: 1 })
    expect(result.events[1]).toEqual({ type: "event", seq: 2 })
    expect(result.nextOffset).toBeGreaterThan(0)
  })

  it("returns empty events when no new lines exist", async () => {
    const filePath = tmpFile()
    await writeJsonl(filePath, [
      JSON.stringify({ type: "event", seq: 1 }),
    ])

    const reader = createJsonlTailReader(filePath)
    const first = await reader.readNewLines(0)

    // 第二次读取从同一 offset 开始，不应有新事件
    const second = await reader.readNewLines(first.nextOffset)
    expect(second.events).toHaveLength(0)
  })

  it("handles half-written lines by keeping them for next read", async () => {
    const filePath = tmpFile()
    const fullLine = JSON.stringify({ type: "event", seq: 1 })
    const halfLine = fullLine.slice(0, 10)
    // 先写半行
    await writeFile(filePath, halfLine, "utf8")

    const reader = createJsonlTailReader(filePath)
    const first = await reader.readNewLines(0)

    // 半行不应被当作事件；offset 推进到已读字节数（半行缓存在内存）
    expect(first.events).toHaveLength(0)
    const halfBytes = Buffer.byteLength(halfLine, "utf8")
    expect(first.nextOffset).toBe(halfBytes)

    // 追写剩余部分（追加到文件末尾）
    await appendFile(filePath, fullLine.slice(10) + "\n", "utf8")

    // 从上次偏移继续读取
    const second = await reader.readNewLines(first.nextOffset)
    expect(second.events).toHaveLength(1)
    expect(second.events[0]).toEqual({ type: "event", seq: 1 })
  })

  it("skips empty lines", async () => {
    const filePath = tmpFile()
    await writeJsonl(filePath, [
      "",
      JSON.stringify({ type: "event", seq: 1 }),
      "",
      JSON.stringify({ type: "event", seq: 2 }),
      "",
    ])

    const reader = createJsonlTailReader(filePath)
    const result = await reader.readNewLines(0)

    expect(result.events).toHaveLength(2)
    expect(result.events[0]).toEqual({ type: "event", seq: 1 })
  })

  it("handles non-JSON lines gracefully by skipping them", async () => {
    const filePath = tmpFile()
    await writeJsonl(filePath, [
      "this is not json",
      JSON.stringify({ type: "event", seq: 1 }),
      "also not json",
    ])

    const reader = createJsonlTailReader(filePath)
    const result = await reader.readNewLines(0)

    expect(result.events).toHaveLength(1)
    expect(result.events[0]).toEqual({ type: "event", seq: 1 })
  })

  it("returns empty events for missing file", async () => {
    const reader = createJsonlTailReader("/tmp/nonexistent-file-12345.jsonl")
    const result = await reader.readNewLines(0)

    expect(result.events).toHaveLength(0)
    expect(result.nextOffset).toBe(0)
  })

  it("only returns new events after previous offset", async () => {
    const filePath = tmpFile()
    await writeJsonl(filePath, [
      JSON.stringify({ type: "event", seq: 1 }),
      JSON.stringify({ type: "event", seq: 2 }),
      JSON.stringify({ type: "event", seq: 3 }),
    ])

    const reader = createJsonlTailReader(filePath)
    const first = await reader.readNewLines(0)
    expect(first.events).toHaveLength(3)

    // 追加新行
    await writeFile(
      filePath,
      [
        JSON.stringify({ type: "event", seq: 1 }),
        JSON.stringify({ type: "event", seq: 2 }),
        JSON.stringify({ type: "event", seq: 3 }),
        JSON.stringify({ type: "event", seq: 4 }),
        JSON.stringify({ type: "event", seq: 5 }),
      ].join("\n") + "\n",
      "utf8",
    )

    const second = await reader.readNewLines(first.nextOffset)
    expect(second.events).toHaveLength(2)
    expect(second.events[0]).toEqual({ type: "event", seq: 4 })
    expect(second.events[1]).toEqual({ type: "event", seq: 5 })
  })
})
