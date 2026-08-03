/**
 * 统一 workflow 状态事件发布模块。
 *
 * 业务模块通过 publish() 发布结构化事件，terminal UI 通过 subscribe() 消费。
 * 事件发布不依赖读取终端日志，不阻塞 Agent 监测。
 * 事件和快照不携带任何 Blessed 类型。
 */

// ── 事件类型 ──

export type IssueChangeEvent = {
  type: "issue_change"
  issueIndex: number
  issueCount: number
  issueTitle: string
}

export type PhaseChangeEvent = {
  type: "phase_change"
  phase: WorkflowPhase
}

export type ReviewRoundChangeEvent = {
  type: "review_round_change"
  round: number
  maxRounds: number
}

export type AgentStateChangeEvent = {
  type: "agent_state_change"
  agent: "implementer" | "reviewer"
  status: AgentDisplayStatus
}

export type NeedsInputEvent = {
  type: "needs_input"
  agent: "implementer" | "reviewer"
  provider: string
  reason: string
}

export type PauseEvent = {
  type: "pause"
  reason: string
}

export type CompleteEvent = {
  type: "complete"
}

export type FailEvent = {
  type: "fail"
  reason: string
}

/** 用户在 terminal 面板中的交互操作 */
export type UserActionEvent = {
  type: "user_action"
  /** 操作类型 */
  action: string
  /** 操作的目标 agent */
  agent: "implementer" | "reviewer"
}

/**
 * 交互请求。
 *
 * 由 workflow 发起，terminal UI 展示并收集用户输入。
 */
export type InteractionRequest = {
  prompt: string
  actions?: string[]
  agent: "implementer" | "reviewer"
}

export type InteractionResult = {
  action: string
}

export type WorkflowEvent =
  | IssueChangeEvent
  | PhaseChangeEvent
  | ReviewRoundChangeEvent
  | AgentStateChangeEvent
  | NeedsInputEvent
  | PauseEvent
  | CompleteEvent
  | FailEvent
  | UserActionEvent

// ── 快照类型 ──

/** Agent 在快照中的展示状态 */
export type AgentDisplayStatus = "idle" | "working" | "completed" | "failed" | "needs_input"

/** Workflow 阶段 */
export type WorkflowPhase = "idle" | "implement" | "review" | "revise" | "post-check" | "controller-revise"

/** 需要人工输入的详情 */
export type NeedsInputDetail = {
  agent: "implementer" | "reviewer"
  provider: string
  reason: string
}

/**
 * Workflow 状态快照，包含 spec §11 要求的所有字段。
 * 供 terminal UI 渲染，不依赖读取终端日志。
 */
export type WorkflowSnapshot = {
  /** 当前 issue 索引（0-based） */
  issueIndex: number
  /** 总 issue 数 */
  issueCount: number
  /** 当前 issue 标题 */
  issueTitle: string
  /** 当前阶段 */
  phase: WorkflowPhase
  /** 当前 review 轮次（1-based） */
  reviewRound: number
  /** 最大 review 轮次 */
  maxReviewRounds: number
  /** implementer 状态 */
  implementerStatus: AgentDisplayStatus
  /** reviewer 状态 */
  reviewerStatus: AgentDisplayStatus
  /** 累计耗时（ms） */
  elapsedMs: number
  /** 需要人工输入详情（null = 无） */
  needsInput: NeedsInputDetail | null
  /** workflow 终态（null = 进行中） */
  terminalState: "completed" | "failed" | "paused" | null
  /** workflow 开始时间戳 */
  startedAt: number
}

// ── 事件总线 ──

export type WorkflowEventSubscriber = (event: WorkflowEvent) => void | Promise<void>

export type WorkflowEventBus = {
  /** 发布事件并更新快照 */
  publish: (event: WorkflowEvent) => void
  /** 订阅事件流，返回 unsubscribe 函数 */
  subscribe: (subscriber: WorkflowEventSubscriber) => () => void
  /** 获取当前快照 */
  getSnapshot: () => WorkflowSnapshot
  /** 重置快照到初始状态 */
  reset: () => void
  /**
   * 请求用户交互（terminal 面板）。
   *
   * 返回 Promise，当用户在面板中完成操作时 resolve。
   * 如果没有注册 handler（非 TTY 模式），立即 reject。
   */
  requestInteraction: (request: InteractionRequest) => Promise<InteractionResult>
  /**
   * 注册交互 handler（由 terminal UI 调用）。
   *
   * 当 requestInteraction 被调用时，handler 会被执行。
   */
  setInteractionHandler: (handler: ((request: InteractionRequest) => Promise<InteractionResult>) | null) => void
}

const initialSnapshot = (startedAt: number): WorkflowSnapshot => ({
  issueIndex: 0,
  issueCount: 0,
  issueTitle: "",
  phase: "idle",
  reviewRound: 0,
  maxReviewRounds: 0,
  implementerStatus: "idle",
  reviewerStatus: "idle",
  elapsedMs: 0,
  needsInput: null,
  terminalState: null,
  startedAt,
})

/** 将 AgentStatus 映射为展示状态 */
const mapAgentStatus = (status: string): AgentDisplayStatus => {
  switch (status) {
    case "working": return "working"
    case "completed": return "completed"
    case "failed": return "failed"
    case "needs_input": return "needs_input"
    default: return "idle"
  }
}

/**
 * 创建 workflow 事件总线。
 *
 * - publish() 同步更新快照并通知所有订阅者
 * - subscribe() 返回 unsubscribe 函数
 * - getSnapshot() 返回当前快照副本
 * - 事件不携带 Blessed 类型
 */
export const createWorkflowEventBus = (startedAt = Date.now()): WorkflowEventBus => {
  let snapshot = initialSnapshot(startedAt)
  let finishedAt: number | undefined
  const subscribers = new Set<WorkflowEventSubscriber>()
  let interactionHandler: ((request: InteractionRequest) => Promise<InteractionResult>) | null = null
  const getElapsedMs = () => (finishedAt ?? Date.now()) - snapshot.startedAt

  const applyToSnapshot = (event: WorkflowEvent) => {
    const now = Date.now()

    switch (event.type) {
      case "issue_change":
        snapshot = {
          ...snapshot,
          issueIndex: event.issueIndex,
          issueCount: event.issueCount,
          issueTitle: event.issueTitle,
        }
        break

      case "phase_change":
        snapshot = { ...snapshot, phase: event.phase }
        break

      case "review_round_change":
        snapshot = {
          ...snapshot,
          reviewRound: event.round,
          maxReviewRounds: event.maxRounds,
        }
        break

      case "agent_state_change": {
        const status = mapAgentStatus(event.status)
        const key = event.agent === "implementer" ? "implementerStatus" : "reviewerStatus"
        snapshot = {
          ...snapshot,
          [key]: status,
          // agent 重新开始工作时清除 needsInput，并恢复 paused 状态
          ...(event.status === "working"
            ? { needsInput: null, terminalState: null }
            : {}),
        }
        break
      }

      case "needs_input":
        snapshot = {
          ...snapshot,
          needsInput: {
            agent: event.agent,
            provider: event.provider,
            reason: event.reason,
          },
        }
        break

      case "pause":
        snapshot = { ...snapshot, terminalState: "paused" }
        break

      case "complete":
        snapshot = { ...snapshot, terminalState: "completed" }
        finishedAt ??= now
        break

      case "fail":
        snapshot = { ...snapshot, terminalState: "failed" }
        finishedAt ??= now
        break

    }

    snapshot = { ...snapshot, elapsedMs: (finishedAt ?? now) - snapshot.startedAt }
  }

  return {
    publish: (event: WorkflowEvent) => {
      applyToSnapshot(event)
      // 异步调度订阅回调，隔离单个 subscriber 的异常，保持事件顺序
      for (const subscriber of subscribers) {
        queueMicrotask(() => {
          try {
            const result = subscriber(event)
            // 显式捕获 Promise subscriber 的 rejection
            if (result && typeof (result as Promise<void>).catch === "function") {
              (result as Promise<void>).catch((err) => {
                console.error("[EventBus] async subscriber error:", err)
              })
            }
          } catch (err) {
            console.error("[EventBus] subscriber error:", err)
          }
        })
      }
    },

    subscribe: (subscriber: WorkflowEventSubscriber) => {
      subscribers.add(subscriber)
      return () => { subscribers.delete(subscriber) }
    },

    getSnapshot: () => ({ ...snapshot, elapsedMs: getElapsedMs() }),

    reset: () => {
      finishedAt = undefined
      snapshot = initialSnapshot(startedAt)
    },

    requestInteraction: (request) => {
      if (!interactionHandler) {
        return Promise.reject(new Error("No interaction handler registered (non-interactive mode)"))
      }
      return interactionHandler(request)
    },

    setInteractionHandler: (handler) => {
      interactionHandler = handler
    },
  }
}
