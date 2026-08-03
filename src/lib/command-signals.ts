type SignalProcess = {
  on: (signal: string, handler: () => void) => unknown
  removeListener: (signal: string, handler: () => void) => unknown
  exit: (code: number) => never
}

/** 为非 TTY 命令补充信号退出处理，让 exit 事件能够输出最终耗时。 */
export const registerNonInteractiveSignalHandlers = (processRef: SignalProcess) => {
  const sigintHandler = () => processRef.exit(130)
  const sigtermHandler = () => processRef.exit(143)

  processRef.on("SIGINT", sigintHandler)
  processRef.on("SIGTERM", sigtermHandler)

  return () => {
    processRef.removeListener("SIGINT", sigintHandler)
    processRef.removeListener("SIGTERM", sigtermHandler)
  }
}
