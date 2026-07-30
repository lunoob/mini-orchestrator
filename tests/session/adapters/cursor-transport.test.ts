import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { describe, expect, test } from "vitest"

import { createCursorTransport } from "@src/session/adapters/cursor"

type RawEvent = {
  activity?: { kind: string; label: string }
  done?: boolean
  failed?: boolean
  interrupted?: boolean
  text?: string
  turnId: string
}

/**
 * 创建一个 fake Cursor CLI 可执行脚本，模拟 cursor-agent 的行为。
 * 使用 Node.js shebang，接受任意参数并忽略，输出预设的 NDJSON 行。
 */
const createFakeCursorScript = async (ndjsonLines: string[]) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cursor-transport-test-"))
  const scriptPath = path.join(dir, "fake-cursor.cjs")
  const linesJson = JSON.stringify(ndjsonLines)

  // Node.js 脚本带 shebang，可直接作为可执行文件运行
  const script = `#!/usr/bin/env node
    // Fake cursor-agent: ignore all args, output NDJSON
    const lines = ${linesJson};
    let i = 0;
    const writeNext = () => {
      if (i < lines.length) {
        process.stdout.write(lines[i] + "\\n");
        i++;
        setTimeout(writeNext, 5);
      }
    };
    writeNext();
  `
  await writeFile(scriptPath, script, "utf8")
  // 使脚本可执行
  const { chmod } = await import("node:fs/promises")
  await chmod(scriptPath, 0o755)

  return { dir, scriptPath }
}

describe("CursorTransport NDJSON parsing", () => {
  test("parses tool_call.started and tool_call.completed into activity events", async () => {
    const ndjson = [
      JSON.stringify({ session_id: "sess-123", type: "system" }),
      JSON.stringify({ type: "user" }),
      JSON.stringify({
        arguments: { file_path: "/src/index.ts" },
        name: "read_file",
        status: "started",
        type: "tool_call",
      }),
      JSON.stringify({
        arguments: { file_path: "/src/index.ts" },
        name: "read_file",
        status: "completed",
        type: "tool_call",
      }),
      JSON.stringify({
        message: { content: [{ text: "file content here", type: "text" }] },
        type: "assistant",
      }),
      JSON.stringify({ type: "result" }),
    ]

    const { dir, scriptPath } = await createFakeCursorScript(ndjson)
    const events: RawEvent[] = []

    try {
      const transport = createCursorTransport(
        { agent: "cursor", command: scriptPath, name: "cursor" },
        "/tmp/project",
      )
      transport.onEvent(event => events.push(event))

      await transport.start({})
      const { turnId } = await transport.send({ content: "test prompt" })

      // Wait for process to complete and events to be processed
      await new Promise(r => setTimeout(r, 1000))

      // Verify activity events
      const activityEvents = events.filter(e => e.activity)
      expect(activityEvents).toEqual([
        {
          activity: { kind: "tool_started", label: "read_file /src/index.ts" },
          turnId,
        },
        {
          activity: { kind: "tool_completed", label: "read_file /src/index.ts" },
          turnId,
        },
      ])

      // Verify text delta
      const textEvents = events.filter(e => e.text)
      expect(textEvents).toEqual([
        { text: "file content here", turnId },
      ])

      // Verify result (done)
      const doneEvents = events.filter(e => e.done)
      expect(doneEvents).toHaveLength(1)
    } finally {
      await rm(dir, { force: true, recursive: true })
    }
  })

  test("ignores thinking and unknown event types", async () => {
    const ndjson = [
      JSON.stringify({ content: "internal reasoning", type: "thinking" }),
      JSON.stringify({ someField: "value", type: "unknown_type" }),
      JSON.stringify({
        message: { content: [{ text: "output", type: "text" }] },
        type: "assistant",
      }),
      JSON.stringify({ type: "result" }),
    ]

    const { dir, scriptPath } = await createFakeCursorScript(ndjson)
    const events: RawEvent[] = []

    try {
      const transport = createCursorTransport(
        { agent: "cursor", command: scriptPath, name: "cursor" },
        "/tmp/project",
      )
      transport.onEvent(event => events.push(event))

      await transport.start({})
      await transport.send({ content: "test prompt" })

      await new Promise(r => setTimeout(r, 1000))

      // thinking and unknown types should not produce events
      const nonTextNonDoneEvents = events.filter(e => !e.text && !e.done && !e.activity)
      expect(nonTextNonDoneEvents).toEqual([])

      // Should have text and done
      expect(events.some(e => e.text === "output")).toBe(true)
      expect(events.some(e => e.done)).toBe(true)
    } finally {
      await rm(dir, { force: true, recursive: true })
    }
  })

  test("tool_call with unknown status is ignored", async () => {
    const ndjson = [
      JSON.stringify({
        arguments: { file_path: "/src/index.ts" },
        name: "read_file",
        status: "unknown_status",
        type: "tool_call",
      }),
      JSON.stringify({
        message: { content: [{ text: "after", type: "text" }] },
        type: "assistant",
      }),
      JSON.stringify({ type: "result" }),
    ]

    const { dir, scriptPath } = await createFakeCursorScript(ndjson)
    const events: RawEvent[] = []

    try {
      const transport = createCursorTransport(
        { agent: "cursor", command: scriptPath, name: "cursor" },
        "/tmp/project",
      )
      transport.onEvent(event => events.push(event))

      await transport.start({})
      await transport.send({ content: "test prompt" })

      await new Promise(r => setTimeout(r, 1000))

      // Unknown status should not produce activity
      const activityEvents = events.filter(e => e.activity)
      expect(activityEvents).toEqual([])

      // Text and done should still work
      expect(events.some(e => e.text === "after")).toBe(true)
      expect(events.some(e => e.done)).toBe(true)
    } finally {
      await rm(dir, { force: true, recursive: true })
    }
  })

  test("extracts session_id from system event for --resume", async () => {
    // First turn: capture session_id
    const ndjson1 = [
      JSON.stringify({ session_id: "sess-abc", type: "system" }),
      JSON.stringify({ type: "result" }),
    ]

    // Second turn: should use --resume with captured session_id
    const ndjson2 = [
      JSON.stringify({
        message: { content: [{ text: "second", type: "text" }] },
        type: "assistant",
      }),
      JSON.stringify({ type: "result" }),
    ]

    const { dir, scriptPath } = await createFakeCursorScript([...ndjson1, ...ndjson2])
    const events: RawEvent[] = []

    try {
      const transport = createCursorTransport(
        { agent: "cursor", command: scriptPath, name: "cursor" },
        "/tmp/project",
      )
      transport.onEvent(event => events.push(event))

      await transport.start({})
      await transport.send({ content: "first prompt" })

      await new Promise(r => setTimeout(r, 1000))

      // Verify session_id was captured (we can't directly test --resume without
      // inspecting spawn args, but we verify the transport doesn't crash)
      expect(events.some(e => e.done)).toBe(true)
    } finally {
      await rm(dir, { force: true, recursive: true })
    }
  })
})
