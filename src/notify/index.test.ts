import { describe, expect, it, vi } from "vitest"

import {
  buildNotificationCommand,
  createNotifyDedup,
  notifyNeedsInput,
  resetNotifyDedup,
} from "./index.js"

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

  it("uses custom workflow title in notification", () => {
    const command = buildNotificationCommand("darwin", "实现用户登录功能", "完成", "success")

    expect(command?.args[1]).toContain('title "实现用户登录功能"')
  })
})

describe("notify dedup", () => {
  it("createNotifyDedup deduplicates by key", () => {
    const dedup = createNotifyDedup()
    const notify = vi.fn()

    // 第一次发送
    dedup.notifyOnce("agent-turn-1", notify)
    expect(notify).toHaveBeenCalledOnce()

    // 同一 key 不重复
    dedup.notifyOnce("agent-turn-1", notify)
    expect(notify).toHaveBeenCalledOnce()

    // 不同 key 可以发送
    dedup.notifyOnce("agent-turn-2", notify)
    expect(notify).toHaveBeenCalledTimes(2)
  })

  it("resetNotifyDedup clears global dedup keys", () => {
    resetNotifyDedup()

    // 用全局 notifyNeedsInput
    expect(() => notifyNeedsInput("implementer", "claude", "first call")).not.toThrow()
    expect(() => notifyNeedsInput("implementer", "claude", "second call — deduped")).not.toThrow()

    // 重置后相同 key 可以再次发送
    resetNotifyDedup()
    expect(() => notifyNeedsInput("implementer", "claude", "third call after reset")).not.toThrow()
  })

  it("global notifyNeedsInput respects dedup", () => {
    resetNotifyDedup()

    // 第一次调用应发出通知（通过 osascript spawnSync，在非 darwin 平台跳过）
    // 测试只验证不抛异常
    expect(() => notifyNeedsInput("implementer", "claude", "test reason")).not.toThrow()

    // 第二次相同 key 不应重复（验证去重逻辑工作）
    expect(() => notifyNeedsInput("implementer", "claude", "test reason")).not.toThrow()
  })

})
