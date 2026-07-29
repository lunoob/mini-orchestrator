import type { AgentConfig } from "../../types.js"

/** 所有 adapter 统一的事件形状，与 CodexEvent 对齐 */
export type AdapterEvent = {
  data: Record<string, string>
  type: "output_item.done" | "output_text.delta" | "turn.completed" | "turn.failed" | "turn.interrupted"
}

/** adapter 内部通知（供诊断/日志，不影响 Session 状态机） */
export type AdapterNotification = {
  method: string
  params: Record<string, unknown>
}

/** 所有 agent adapter 必须实现的统一接口 */
export type SessionAdapter = {
  /** 向 agent 发送 prompt，启动新 turn；同一 turnId 不重复投递 */
  deliverMessage: (input: { content: string; turnId: string }) => Promise<void>
  /** 清理所有资源（transport、listener、pending 队列） */
  dispose: () => Promise<void>
  /** 中断当前 turn */
  interrupt: (turnId: string) => Promise<void>
  /** 注册事件监听器，返回取消订阅函数 */
  onEvent: (listener: (event: AdapterEvent) => void) => () => void
  /** 启动 adapter 及底层 transport */
  start: () => Promise<void>
  /** 停止 transport */
  stop: () => Promise<void>
}

/** adapter 工厂函数的公共配置 */
export type AdapterOptions = {
  agent: AgentConfig
  cwd: string
  onFailure?: (error: Error) => Promise<void> | void
  onNotification?: (notification: AdapterNotification) => Promise<void> | void
}
