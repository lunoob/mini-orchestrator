import { spawn } from "node:child_process"

export const executable = (name: string) => (process.platform === "win32" ? `${name}.cmd` : name)

export const runCommand = (command: string, args: string[]) =>
  new Promise<number>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" })

    child.once("error", reject)
    child.once("exit", code => resolve(code ?? 1))
  })

export const runCommandOrThrow = async (command: string, args: string[]) => {
  const code = await runCommand(command, args)
  if (code !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(" ")}`)
  }
}
