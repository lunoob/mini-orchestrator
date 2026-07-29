import type { AgentConfig } from "../../types.js"
import { createDefaultCodexAdapter } from "./codex.js"
import { createClaudeAdapter, createClaudeTransport } from "./claude.js"
import { createCursorAdapter, createCursorTransport } from "./cursor.js"
import type { AdapterEvent, AdapterOptions, SessionAdapter } from "./types.js"

type FactoryOptions = AdapterOptions & {
  onEvent: (event: AdapterEvent) => Promise<void> | void
  onFailure: (error: Error) => Promise<void> | void
  onNotification?: (notification: { method: string; params: Record<string, unknown> }) => Promise<void> | void
}

/** 根据 agent 类型创建对应的 SessionAdapter */
export const createSessionAdapter = (options: FactoryOptions): SessionAdapter => {
  switch (options.agent.agent) {
    case "claude": {
      const transport = createClaudeTransport(options.agent, options.cwd)
      return createClaudeAdapter({ ...options, transport })
    }
    case "cursor": {
      const transport = createCursorTransport(options.agent, options.cwd)
      return createCursorAdapter({ ...options, transport })
    }
    case "codex": {
      // Codex 使用已有的 JSON-RPC transport，包装为 SessionAdapter 接口
      const codexAdapter = createDefaultCodexAdapter({
        agent: options.agent,
        cwd: options.cwd,
        emit: event => options.onEvent(event as unknown as AdapterEvent),
        onFailure: options.onFailure,
        onNotification: notification => options.onNotification?.(notification as unknown as { method: string; params: Record<string, unknown> }),
      })
      return {
        deliverMessage: ({ content, turnId }) => codexAdapter.sendMessage({ content, turnId }),
        dispose: async () => {
          await codexAdapter.flush()
          await codexAdapter.stop()
        },
        interrupt: turnId => codexAdapter.interrupt(turnId),
        onEvent: () => () => undefined,
        start: () => codexAdapter.start(),
        stop: () => codexAdapter.stop(),
      }
    }
    default:
      throw new Error(`[Session] Unsupported agent: ${options.agent.agent}`)
  }
}
