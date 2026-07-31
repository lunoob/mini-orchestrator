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
  let timerRunning = false
  let elapsedMs = 0
  let timerStart = 0
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
      bg: "blue",
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
  let textInputMode = false
  let textInputValue = ""
  let selectedAction: string | null = null

  eventBus.setInteractionHandler((request) => {
    currentRequest = request
    textInputValue = ""
    selectedAction = null
    // 无按钮时自动进入文本输入模式
    const hasActions = request.actions && request.actions.length > 0
    textInputMode = !hasActions
    if (!hasActions) {
      selectedAction = "submit"
    }
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
      if (textInputMode) return
      if (!pendingResolve || !currentRequest?.actions) return
      if (i > currentRequest.actions.length) return

      const action = currentRequest.actions[i - 1]
      // "other" 选项或必填文本选项 → 进入文本输入模式
      const needsText = action === "other" || currentRequest.textRequiredFor?.includes(action) === true
      if (needsText) {
        selectedAction = action
        textInputMode = true
        textInputValue = ""
        updateStatusBox(eventBus.getSnapshot())
        return
      }
      // 预设选项：直接 resolve
      // 仅当有 requestOptions 时附带 optionId（用于结构化选项回传）
      const hasStructuredOptions = currentRequest.requestOptions && currentRequest.requestOptions.length > 0
      pendingResolve({ action, optionId: hasStructuredOptions ? action : undefined })
      pendingResolve = null
      currentRequest = null
    })
  }

  // 文本输入模式下的键盘处理
  // ch 为实际字符（含空格、大写），key 用于识别控制键
  screen.on("keypress", (ch: string, key: { name: string; ctrl?: boolean }) => {
    if (!textInputMode || !pendingResolve) return

    if (key.name === "return" || key.name === "enter") {
      // Enter 提交，使用之前选中的 action
      if (!selectedAction) return
      const hasText = textInputValue.trim().length > 0
      const isRequired = currentRequest?.textRequiredFor?.includes(selectedAction)
      // 必填文本模式要求非空；可选文本模式允许空文本
      if (hasText || (!isRequired && currentRequest?.textOptional)) {
        pendingResolve({ action: selectedAction, text: textInputValue.trim() || undefined })
        pendingResolve = null
        currentRequest = null
        selectedAction = null
        textInputMode = false
        textInputValue = ""
      }
      return
    }

    if (key.name === "escape") {
      // 无按钮模式：Esc 直接取消交互（workflow 不阻塞）
      if (!currentRequest?.actions?.length) {
        if (pendingResolve) {
          pendingResolve({ action: "abort" })
          pendingResolve = null
          currentRequest = null
        }
        return
      }
      // 有按钮模式：Esc 退出文本输入，回到按钮选择
      textInputMode = false
      textInputValue = ""
      selectedAction = null
      const snap = eventBus.getSnapshot()
      updateStatusBox(snap)
      return
    }

    if (key.name === "backspace") {
      textInputValue = textInputValue.slice(0, -1)
      const snap = eventBus.getSnapshot()
      updateStatusBox(snap)
      return
    }

    // 用 ch 追加可打印字符（含空格、大写、符号等）
    if (ch && !key.ctrl) {
      textInputValue += ch
      const snap = eventBus.getSnapshot()
      updateStatusBox(snap)
    }
  })

  // 停止计时（内部辅助）
  const freezeTimer = () => {
    if (timerRunning) {
      timerRunning = false
      elapsedMs = Date.now() - timerStart
      clearInterval(timerInterval)
    }
  }

  // 更新状态面板
  const updateStatusBox = (snap: WorkflowSnapshot) => {
    // 仅在 workflow 真正结束（completed/failed）时冻结计时
    // paused 和 needs_input 期间继续累计等待时间
    if (snap.terminalState === "completed" || snap.terminalState === "failed") {
      freezeTimer()
    }

    // 构建带文本输入状态的交互请求
    let displayRequest = currentRequest
    if (textInputMode && currentRequest) {
      displayRequest = {
        ...currentRequest,
        prompt: currentRequest.prompt,
        // 在 actions 后追加文本输入显示
      }
    }

    const layout = calculateLayout(snap, screen.cols, screen.rows, displayRequest)

    // 在文本输入模式下追加输入行（显示已选 action）
    const displayLines = [...layout.lines]
    if (textInputMode) {
      const actionLabel = selectedAction ? `[${selectedAction}] ` : ""
      displayLines.push(`${actionLabel}> ${textInputValue}█`)
    }

    // 更新状态面板内容和高度
    statusBox.setContent(displayLines.join("\n"))
    statusBox.height = displayLines.length

    // 更新日志区高度
    logWidget.height = Math.max(0, screen.rows - displayLines.length)

    screen.render()
  }

  // 订阅事件
  unsubscribe = eventBus.subscribe((event) => {
    // workflow 实际开始执行时启动计时器
    if (event.type === "workflow_started" && !timerRunning) {
      timerStart = event.startedAt
      timerRunning = true
    }
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
    clearInterval(timerInterval)
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

  const sigintHandler = () => { exitHandler(); process.exit(130) }
  const sigtermHandler = () => { exitHandler(); process.exit(143) }
  const uncaughtHandler = (err: Error) => {
    // 先将异常记录到日志历史，再 destroy + flush，确保信息在普通缓冲区可见
    logHistory.push({ text: `[FATAL] ${err.message}\n${err.stack ?? ""}`, stream: "stderr" })
    exitHandler()
    process.exit(1)
  }

  process.on("SIGINT", sigintHandler)
  process.on("SIGTERM", sigtermHandler)
  process.on("uncaughtException", uncaughtHandler)

  // 定时器更新
  const timerInterval = setInterval(() => {
    if (timerRunning) {
      elapsedMs = Date.now() - timerStart
      const snap = eventBus.getSnapshot()
      updateStatusBox(snap)
    }
  }, 1000)

  return {
    getLogSink: () => sink,
    updateStatus: updateStatusBox,
    formatElapsed,
    isTimerRunning: () => timerRunning,
    getElapsedMs: () => elapsedMs,
    stopTimer: () => {
      timerRunning = false
      elapsedMs = Date.now() - timerStart
      clearInterval(timerInterval)
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
