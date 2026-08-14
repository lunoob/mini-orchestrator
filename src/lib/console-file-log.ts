import { format } from "node:util"
import { createWriteStream } from "node:fs"
import { mkdir } from "node:fs/promises"
import path from "node:path"

/**
 * 将 console.log/warn/error 同时写入文件，输出行为透传给原有 console（保留屏幕渲染）。
 * 通过保存并链式调用当前 console 函数，可叠加在 main.ts 的 blessed sink 代理之上。
 */
export const startConsoleFileLog = async (projectDir: string, workflowName: string) => {
  const dir = path.join(projectDir, ".orchestrator", workflowName)
  await mkdir(dir, { recursive: true })
  const filePath = path.join(dir, `run-${Date.now()}.log`)
  const stream = createWriteStream(filePath, { flags: "a" })

  const originalLog = console.log
  const originalWarn = console.warn
  const originalError = console.error

  const write = (message: string) => stream.write(message + "\n")

  console.log = (...args) => {
    write(format(...args))
    originalLog(...args)
  }
  console.warn = (...args) => {
    write(format(...args))
    originalWarn(...args)
  }
  console.error = (...args) => {
    write(format(...args))
    originalError(...args)
  }

  return {
    filePath,
    restore: () => {
      console.log = originalLog
      console.warn = originalWarn
      console.error = originalError
    },
    close: () => new Promise<void>((resolve) => stream.end(resolve)),
  }
}
