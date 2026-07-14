import { spawn } from "node:child_process"

const DELAY_MS = 800

export const run = async (command: string, args: string[]) => {
  await new Promise(resolve => setTimeout(resolve, DELAY_MS))
  return new Promise<{ code: number | null; stderr: string; stdout: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString()
    })
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString()
    })

    child.on("error", reject)
    child.on("close", (code) => resolve({ code, stdout, stderr }))
  })
}

export const runHerdr = async (args: string[]) => {
  const { code, stderr, stdout } = await run("herdr", args)
  if (code === 0) return stdout.trim()

  throw new Error(`[Agent] ${stderr.trim() || `herdr ${args.join(" ")} failed with code ${code}`}`)
}
