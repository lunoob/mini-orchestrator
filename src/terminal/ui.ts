/**
 * Terminal UI 模块。
 *
 * 使用 Blessed 构建"上方日志滚动区 + 下方固定状态面板"的终端 UI。
 * 非 TTY 模式下提供纯文本日志 sink，不加载 Blessed。
 */

import type { WorkflowEventBus, WorkflowSnapshot, InteractionRequest, InteractionResult } from "../workflow/events.js"
import { calculateLayout, formatElapsed } from "./layout.js"

export type LogSink = {
  log: (message: string) => void
  /** 输出到 stderr（用于 warn/error 级别） */
  logStderr: (message: string) => void
}

export type TerminalUI = {
  getLogSink: () => LogSink
  updateStatus: (snapshot: WorkflowSnapshot) => void
  formatElapsed: (ms: number) => string
  isTimerRunning: () => boolean
  getElapsedMs: () => number
  stopTimer: () => void
  teardown: () => void
}

/** 创建非 TTY 模式的纯文本 UI */
export const createPlainTextUI = (_eventBus: WorkflowEventBus): TerminalUI => {
  const sink: LogSink = {
    log: (message: string) => {
      process.stdout.write(message + "\n")
    },
    logStderr: (message: string) => {
      process.stderr.write(message + "\n")
    },
  }

  return {
    getLogSink: () => sink,
    updateStatus: () => {
      // 非 TTY 模式不渲染状态
    },
    formatElapsed,
    isTimerRunning: () => false,
    getElapsedMs: () => 0,
    stopTimer: () => {},
    teardown: () => {},
  }
}

/**
 * 创建 TTY 模式的 Blessed UI。
 *
 * 接收 blessed 模块作为依赖，方便测试时注入 mock。
 */
export const createBlessedUI = (
  eventBus: WorkflowEventBus,
  blessed: typeof import("blessed"),
): TerminalUI => {
  const initialSnapshot = eventBus.getSnapshot()
  let timerRunning = true
  let elapsedMs = initialSnapshot.elapsedMs
  let timerStart = initialSnapshot.startedAt
  let timerInterval: ReturnType<typeof setInterval> | undefined
  let unsubscribe: (() => void) | null = null
  const logHistory: Array<{ text: string; stream: "stdout" | "stderr" }> = []

  // 创建 screen（启用 fullUnicode 支持 CJK 双宽字符）
  const screen = blessed.screen({
    smartCSR: true,
    title: "mini-orch",
    forceUnicode: true,
    fullUnicode: true,
  })

  // 清屏：通过 program 发送 ANSI 清屏序列
  screen.program.write("\x1b[2J\x1b[H")

  // 创建日志区（关闭 tags 避免动态内容被误解析为 Blessed 标签）
  const logWidget = blessed.log({
    top: 0,
    left: 0,
    width: "100%",
    height: "100%-1",
    scrollable: true,
    alwaysScroll: false,
    scrollbar: {
      ch: " ",
    },
    tags: false,
  })

  // 创建状态面板（关闭 tags 避免 issue 标题、reason 等动态内容被误解析）
  const statusBox = blessed.box({
    bottom: 0,
    left: 0,
    width: "100%",
    height: 1,
    tags: false,
    style: {
      fg: "white",
      bg: "#42454b",
    },
  })

  screen.append(logWidget)
  screen.append(statusBox)

  // 跟踪是否处于自动跟随模式（用户在底部时自动滚动）
  let following = true

  // 给 logWidget 设置 key 处理以支持滚动
  logWidget.key(["up", "k"], () => {
    logWidget.scroll(-1)
    following = false
    screen.render()
  })
  logWidget.key(["down", "j"], () => {
    logWidget.scroll(1)
    // 如果已到底部，恢复跟随模式
    const scrollPerc = logWidget.getScrollPerc()
    if (scrollPerc >= 98) following = true
    screen.render()
  })
  logWidget.key(["pageup"], () => {
    logWidget.scroll(-Math.floor(logWidget.height as number))
    following = false
    screen.render()
  })
  logWidget.key(["pagedown"], () => {
    logWidget.scroll(Math.floor(logWidget.height as number))
    const scrollPerc = logWidget.getScrollPerc()
    if (scrollPerc >= 98) following = true
    screen.render()
  })
  logWidget.key(["home"], () => {
    logWidget.setScrollPerc(0)
    following = false
    screen.render()
  })
  logWidget.key(["end"], () => {
    logWidget.setScrollPerc(100)
    following = true
    screen.render()
  })

  // 初始聚焦到日志区
  logWidget.focus()

  // 交互处理：注册 interaction handler 供 workflow 的 requestInteraction 使用
  let pendingResolve: ((result: InteractionResult) => void) | null = null
  let currentRequest: InteractionRequest | null = null

  eventBus.setInteractionHandler((request) => {
    currentRequest = request
    // 立即刷新面板以显示交互请求
    const snap = eventBus.getSnapshot()
    updateStatusBox(snap)
    return new Promise<InteractionResult>((resolve) => {
      pendingResolve = resolve
    })
  })

  // 数字键选择选项
  for (let i = 1; i <= 9; i++) {
    screen.key([String(i)], () => {
      if (!pendingResolve || !currentRequest?.actions) return
      if (i > currentRequest.actions.length) return

      const action = currentRequest.actions[i - 1]
      pendingResolve({ action })
      pendingResolve = null
      currentRequest = null
    })
  }

  const clearTimerInterval = () => {
    if (timerInterval !== undefined) {
      clearInterval(timerInterval)
      timerInterval = undefined
    }
  }

  // 停止计时（内部辅助）
  const freezeTimer = () => {
    if (!timerRunning) {
      clearTimerInterval()
      return
    }

    timerRunning = false
    elapsedMs = Date.now() - timerStart
    clearTimerInterval()
  }

  // 更新状态面板
  const updateStatusBox = (snap: WorkflowSnapshot) => {
    // 命令计时仅在 workflow 真正结束（completed/failed）时冻结
    // paused 和 needs_input 期间继续累计等待时间
    if (snap.terminalState === "completed" || snap.terminalState === "failed") {
      freezeTimer()
    }

    const layout = calculateLayout(snap, screen.cols, screen.rows, currentRequest)

    // 更新状态面板内容和高度
    statusBox.setContent(layout.lines.join("\n"))
    statusBox.height = layout.lines.length

    // 更新日志区高度
    logWidget.height = Math.max(0, screen.rows - layout.lines.length)

    screen.render()
  }

  // 订阅事件
  unsubscribe = eventBus.subscribe(() => {
    const snap = eventBus.getSnapshot()
    updateStatusBox(snap)
  })

  // 监听 resize 事件，重新计算布局
  screen.on("resize", () => {
    const snap = eventBus.getSnapshot()
    updateStatusBox(snap)
  })

  // 立即渲染初始快照
  updateStatusBox(eventBus.getSnapshot())

  // 日志 sink（保存历史以便 teardown 时 flush，区分 stdout/stderr）
  const sink: LogSink = {
    log: (message: string) => {
      logHistory.push({ text: message, stream: "stdout" })
      logWidget.log(message)
      if (following) {
        logWidget.setScrollPerc(100)
      }
      screen.render()
    },
    logStderr: (message: string) => {
      logHistory.push({ text: message, stream: "stderr" })
      logWidget.log(message)
      if (following) {
        logWidget.setScrollPerc(100)
      }
      screen.render()
    },
  }

  // 幂等 teardown 标记
  let tornDown = false

  // 统一的退出处理（覆盖正常结束、SIGINT、SIGTERM、未捕获异常）
  const exitHandler = () => {
    if (tornDown) return
    tornDown = true
    freezeTimer()
    clearTimerInterval()
    timerRunning = false
    if (unsubscribe) { unsubscribe(); unsubscribe = null }
    process.removeListener("SIGINT", sigintHandler)
    process.removeListener("SIGTERM", sigtermHandler)
    process.removeListener("uncaughtException", uncaughtHandler)
    screen.destroy()
    // 按原始 stream 类型 flush 日志历史
    for (const entry of logHistory) {
      const dest = entry.stream === "stderr" ? process.stderr : process.stdout
      dest.write(entry.text + "\n")
    }
  }

  // 快速按两下 Ctrl+C 才退出：记录首次按下时间，1 秒内再次按下才触发
  let lastSigintAt = 0
  const SIGINT_DOUBLE_PRESS_MS = 1_000
  const sigintHandler = () => {
    const now = Date.now()
    if (now - lastSigintAt > SIGINT_DOUBLE_PRESS_MS) {
      lastSigintAt = now
      return
    }
    exitHandler()
    process.exit(130)
  }
  const sigtermHandler = () => { exitHandler(); process.exit(143) }
  const uncaughtHandler = (err: Error) => {
    // 先将异常记录到日志历史，再 destroy + flush，确保信息在普通缓冲区可见
    logHistory.push({ text: `[FATAL] ${err.message}\n${err.stack ?? ""}`, stream: "stderr" })
    exitHandler()
    process.exit(1)
  }

  // blessed 将终端置于 raw 模式，Ctrl+C 不会产生 SIGINT 信号，而是 keypress 事件，需显式绑定
  screen.key(["C-c"], sigintHandler)

  process.on("SIGINT", sigintHandler)
  process.on("SIGTERM", sigtermHandler)
  process.on("uncaughtException", uncaughtHandler)

  // 定时器更新
  if (timerRunning) {
    timerInterval = setInterval(() => {
      elapsedMs = Date.now() - timerStart
      const snap = eventBus.getSnapshot()
      updateStatusBox(snap)
    }, 1000)
  }

  return {
    getLogSink: () => sink,
    updateStatus: updateStatusBox,
    formatElapsed,
    isTimerRunning: () => timerRunning,
    getElapsedMs: () => elapsedMs,
    stopTimer: () => {
      freezeTimer()
    },
    teardown: () => {
      exitHandler()
    },
  }
}

/**
 * 检查当前是否为交互式 TTY 环境。
 *
 * 需要 stdin、stdout、stderr 均为 TTY 才能启用 Blessed UI。
 * 任一非 TTY（如管道重定向、后台进程）则使用纯文本模式。
 */
export const isInteractiveTTY = (): boolean => {
  return !!(process.stdout.isTTY && process.stdin.isTTY && process.stderr.isTTY)
}

/**
 * 创建 Terminal UI。
 *
 * TTY 模式下使用 Blessed 构建完整的终端 UI。
 * 非 TTY 模式下提供纯文本日志 sink。
 */
export const createTerminalUI = async (eventBus: WorkflowEventBus): Promise<TerminalUI> => {
  if (!isInteractiveTTY()) {
    return createPlainTextUI(eventBus)
  }

  const blessed = await import("blessed")
  return createBlessedUI(eventBus, blessed.default ?? blessed)
}
