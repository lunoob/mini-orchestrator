import { describe, expect, it } from "vitest"

import { buildNotificationCommand } from "./index.js"

describe("buildNotificationCommand", () => {
  it("uses macOS osascript", () => {
    const command = buildNotificationCommand(
      "darwin",
      "编排器",
      "第一行\n第二行",
      "warning",
    )

    expect(command).toEqual({
      command: "osascript",
      args: [
        "-e",
        'display notification "第一行\\n第二行" with title "编排器" subtitle "⚠️ 需要人工 Review"',
      ],
    })
  })

  it("escapes quotes and backslashes in notification values", () => {
    const command = buildNotificationCommand("darwin", '标题 "A"', "路径 \\tmp", "error")

    expect(command?.args[1]).toContain('title "标题 \\"A\\""')
    expect(command?.args[1]).toContain('display notification "路径 \\\\tmp"')
  })

  it("does not call an external notifier on unsupported platforms", () => {
    expect(buildNotificationCommand("freebsd", "标题", "消息", "success")).toBeUndefined()
  })
})
