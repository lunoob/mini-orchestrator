import { spawn } from "node:child_process"

/** 子进程输出回调：(消息, 流类型) => void */
export type OutputCallback = (message: string, stream: "stdout" | "stderr") => void

const DELAY_MS = 1500

export const run = async (command: string, args: string[], onOutput?: OutputCallback) => {
  await new Promise(resolve => setTimeout(resolve, DELAY_MS))
  return new Promise<{ code: number | null; stderr: string; stdout: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""

    child.stdout.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString()
      stdout += text
      if (onOutput) {
        for (const line of text.split("\n")) {
          if (line) onOutput(line, "stdout")
        }
      }
    })
    child.stderr.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString()
      stderr += text
      if (onOutput) {
        for (const line of text.split("\n")) {
          if (line) onOutput(line, "stderr")
        }
      }
    })

    child.on("error", reject)
    child.on("close", (code) => resolve({ code, stdout, stderr }))
  })
}

export const runHerdr = async (args: string[], onOutput?: OutputCallback) => {
  const { code, stderr, stdout } = await run("herdr", args, onOutput)
  if (code === 0) return stdout.trim()

  throw new Error(`[Agent] ${stderr.trim() || `herdr ${args.join(" ")} failed with code ${code}`}`)
}

export const tryRunHerdr = async (args: string[], onOutput?: OutputCallback) => {
  const { code, stderr, stdout } = await run("herdr", args, onOutput)
  return { code, stderr: stderr.trim(), stdout: stdout.trim() }
}
