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

export type InvalidOutputEvent = {
  type: "invalid_output"
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
 * 结构化交互请求。
 *
 * 由 workflow 发起，terminal UI 展示并收集用户输入。
 */
export type InteractionRequest = {
  /** 显示给用户的提示信息 */
  prompt: string
  /** 可选的预定义操作列表（如 approve/revise/retry-review/abort） */
  actions?: string[]
  /** 操作的目标 agent */
  agent: "implementer" | "reviewer"
  /** 需要必填文本输入的 action 列表（如 ["revise", "retry-review"]） */
  textRequiredFor?: string[]
  /** 所有 action 是否允许可选文本输入 */
  textOptional?: boolean
  /** 文本输入的占位提示 */
  textInputPlaceholder?: string
}

/**
 * 结构化交互结果。
 */
export type InteractionResult = {
  /** 用户选择的操作 */
  action: string
  /** 用户输入的文本（如 notes） */
  text?: string
}

export type WorkflowEvent =
  | IssueChangeEvent
  | PhaseChangeEvent
  | ReviewRoundChangeEvent
  | AgentStateChangeEvent
  | NeedsInputEvent
  | InvalidOutputEvent
  | PauseEvent
  | CompleteEvent
  | FailEvent
  | UserActionEvent

// ── 快照类型 ──

/** Agent 在快照中的展示状态 */
export type AgentDisplayStatus = "idle" | "working" | "completed" | "failed" | "needs_input" | "invalid_output"

/** Workflow 阶段 */
export type WorkflowPhase = "idle" | "implement" | "review" | "revise" | "post-check" | "controller-revise"

/** 需要人工输入的详情 */
export type NeedsInputDetail = {
  agent: "implementer" | "reviewer"
  provider: string
  reason: string
}

/** 无效输出的详情 */
export type InvalidOutputDetail = {
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
  /** 无效输出详情（null = 无） */
  invalidOutput: InvalidOutputDetail | null
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

const initialSnapshot = (): WorkflowSnapshot => ({
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
  invalidOutput: null,
  terminalState: null,
  startedAt: Date.now(),
})

/** 将 AgentStatus 映射为展示状态 */
const mapAgentStatus = (status: string): AgentDisplayStatus => {
  switch (status) {
    case "working": return "working"
    case "completed": return "completed"
    case "failed": return "failed"
    case "needs_input": return "needs_input"
    case "invalid_output": return "invalid_output"
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
export const createWorkflowEventBus = (): WorkflowEventBus => {
  let snapshot = initialSnapshot()
  const subscribers = new Set<WorkflowEventSubscriber>()
  let interactionHandler: ((request: InteractionRequest) => Promise<InteractionResult>) | null = null

  const applyToSnapshot = (event: WorkflowEvent) => {
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
          // agent 重新开始工作时清除 needsInput/invalidOutput，并恢复 paused 状态
          ...(event.status === "working"
            ? { needsInput: null, invalidOutput: null, terminalState: null }
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

      case "invalid_output":
        snapshot = {
          ...snapshot,
          invalidOutput: {
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
        break

      case "fail":
        snapshot = { ...snapshot, terminalState: "failed" }
        break
    }

    snapshot = { ...snapshot, elapsedMs: Date.now() - snapshot.startedAt }
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

    getSnapshot: () => ({ ...snapshot, elapsedMs: Date.now() - snapshot.startedAt }),

    reset: () => {
      snapshot = initialSnapshot()
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
