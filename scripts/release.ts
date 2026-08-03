import { spawn } from "node:child_process"

import { loadReleaseEnv } from "../src/release/load-env.js"

const runRelease = () =>
  new Promise<number>(resolve => {
    const command = process.platform === "win32" ? "release-it.cmd" : "release-it"
    const child = spawn(command, process.argv.slice(2), { stdio: "inherit" })

    child.once("error", error => {
      console.error(error.message)
      resolve(1)
    })
    child.once("exit", code => resolve(code ?? 1))
  })

const main = async () => {
  loadReleaseEnv()
  process.exitCode = await runRelease()
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
