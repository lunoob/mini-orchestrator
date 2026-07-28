import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { describe, expect, test } from "vitest"

import { createDefaultCodexAdapter } from "./codex.js"

describe.skipIf(process.env.MINI_ORCH_PROCESS_TEST !== "1")("Codex app-server process transport", () => {
  test("drives a controlled JSON-RPC stdio process without an account", async () => {
    const script = [
      "const readline=require(\"node:readline\")",
      "const out=x=>process.stdout.write(JSON.stringify(x)+\"\\n\")",
      "readline.createInterface({input:process.stdin}).on(\"line\",line=>{",
      "const m=JSON.parse(line)",
      "if(m.method===\"initialize\")out({id:m.id,result:{}})",
      "if(m.method===\"thread/start\")out({id:m.id,result:{thread:{id:\"thread-process\"}}})",
      "if(m.method===\"turn/start\"){out({id:m.id,result:{turn:{id:\"codex-turn\"}}});out({method:\"item/agentMessage/delta\",params:{delta:\"process output\",itemId:\"item-1\",threadId:\"thread-process\",turnId:\"codex-turn\"}});out({method:\"turn/completed\",params:{threadId:\"thread-process\",turn:{id:\"codex-turn\",status:\"completed\"}}})}",
      "})",
    ].join(";")
    const directory = await mkdtemp(path.join(os.tmpdir(), "mini-orch-codex-process-"))
    const scriptPath = path.join(directory, "fake-codex.cjs")
    await writeFile(scriptPath, script, "utf8")
    const events: unknown[] = []
    const adapter = createDefaultCodexAdapter({
      agent: {
        agent: "codex",
        command: `"${process.execPath}" "${scriptPath}"`,
        name: "codex",
      },
      cwd: process.cwd(),
      emit: event => { events.push(event) },
    })

    try {
      await adapter.start()
      await adapter.sendMessage({ content: "prompt", turnId: "turn-1" })
      await expect.poll(() => events.length, { timeout: 10_000 }).toBe(2)

      expect(events).toEqual([
        { data: { delta: "process output", turnId: "turn-1" }, type: "output_text.delta" },
        { data: { turnId: "turn-1" }, type: "turn.completed" },
      ])
    } finally {
      await adapter.stop()
      await rm(directory, { force: true, recursive: true })
    }
  }, 15_000)
})
