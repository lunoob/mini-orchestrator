import { spawn } from "node:child_process"

const runGit = (cwd: string, args: string[]) =>
  new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    })

    let stdout = ""

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString()
    })

    child.on("error", reject)
    child.on("close", (code) => resolve({ code, stdout: stdout.trim() }))
  })

export const isGitRepo = async (projectDir: string) => {
  const { code } = await runGit(projectDir, ["rev-parse", "--git-dir"])
  return code === 0
}

export const getHeadSha = async (projectDir: string) => {
  const { code, stdout } = await runGit(projectDir, ["rev-parse", "HEAD"])
  if (code !== 0) throw new Error(`git rev-parse HEAD failed in ${projectDir}`)
  return stdout
}

export const runGitCommand = async (projectDir: string, args: string[]) => {
  const { code, stdout } = await runGit(projectDir, args)
  if (code !== 0) return ""
  return stdout
}
