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

/** Git 空树 SHA，用于无 baseline 时对比「自仓库起点以来的全部提交」。 */
export const GIT_EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

export const getHeadShaSafe = async (projectDir: string) => {
  const { code, stdout } = await runGit(projectDir, ["rev-parse", "HEAD"])
  return code === 0 ? stdout : undefined
}

export const getHeadSha = async (projectDir: string) => {
  const head = await getHeadShaSafe(projectDir)
  if (!head) throw new Error(`git rev-parse HEAD failed in ${projectDir} (no commits yet?)`)
  return head
}

/** 工作流启动时的 review 基线；非 git 或尚无 commit 时返回 undefined。 */
export const getReviewBaselineSha = async (projectDir: string) => {
  if (!(await isGitRepo(projectDir))) return undefined
  return getHeadShaSafe(projectDir)
}

export const runGitCommand = async (projectDir: string, args: string[]) => {
  const { code, stdout } = await runGit(projectDir, args)
  if (code !== 0) return ""
  return stdout
}
