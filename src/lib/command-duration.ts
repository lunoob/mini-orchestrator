/** 格式化命令退出时展示的总耗时。 */
export const formatCommandDuration = (elapsedMs: number) => {
  const totalSeconds = Math.floor(elapsedMs / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  const duration = [hours, minutes, seconds]
    .map((value) => String(value).padStart(2, "0"))
    .join(":")

  return `\n\n[Workflow] Total duration: ${duration}`
}
