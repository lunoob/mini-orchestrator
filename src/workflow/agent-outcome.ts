/**
 * Agent outcome 契约：定义 implementer 和 reviewer 的 JSON 输出格式。
 *
 * 所有 agent 最终回复必须是一个合法的 JSON 对象，不得包含 Markdown code fence、
 * STATUS 标记或结果分隔符。
 */

// ---- 基础类型 ----

export type OutcomeKind = "completed" | "needs_input" | "failed"

export type InputRequest = {
  question: string
  recommendation?: string
  options?: Array<{ id: string; label: string; description?: string }>
  allowFreeform: boolean
  inputHint?: string
}

export type ReviewVerdict = "pass" | "fail" | "needs_check"

export type ReviewResult = {
  verdict: ReviewVerdict
  cannotVerifySummary?: string
}

export type FailureInfo = {
  message: string
}

// ---- 顶层契约 ----

/** implementer 的 outcome：不得包含 review 字段 */
export type ImplementerOutcome = {
  outcome: OutcomeKind
  summary: string
  report?: string
  request?: InputRequest  // needs_input 时必须
  failure?: FailureInfo   // failed 时必须
}

/** reviewer 的 outcome：completed 时必须包含 review 字段 */
export type ReviewerOutcome = {
  outcome: OutcomeKind
  summary: string
  report?: string
  review?: ReviewResult  // completed 时必须
  request?: InputRequest // needs_input 时必须
  failure?: FailureInfo  // failed 时必须
}

export type AgentOutcome = ImplementerOutcome | ReviewerOutcome

export type AgentRole = "implementer" | "reviewer"

// ---- 解析错误 ----

export class OutcomeParseError extends Error {
  constructor(
    message: string,
    public readonly role: AgentRole,
    public readonly rawOutput: string,
  ) {
    super(message)
    this.name = "OutcomeParseError"
  }
}

// ---- 校验辅助 ----

const VALID_OUTCOMES: readonly OutcomeKind[] = ["completed", "needs_input", "failed"]
const VALID_VERDICTS: readonly ReviewVerdict[] = ["pass", "fail", "needs_check"]

const truncate = (s: string, maxLen = 200) =>
  s.length > maxLen ? s.slice(0, maxLen) + "…" : s

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

// ---- 解析 ----

/**
 * 从 agent 输出中解析 JSON outcome。
 *
 * 只接受一个纯 JSON 对象（允许首尾空白）；
 * 拒绝说明文字、code fence、多个 JSON 对象或缺字段的输入。
 */
export const parseAgentOutcome = (raw: string, role: AgentRole): AgentOutcome => {
  const trimmed = raw.trim()
  if (!trimmed) {
    throw new OutcomeParseError(
      `[Outcome] ${role} 输出为空，无法解析 JSON outcome`,
      role,
      raw,
    )
  }

  // 拒绝 markdown code fence
  if (/^```/.test(trimmed) || /```$/.test(trimmed)) {
    throw new OutcomeParseError(
      `[Outcome] ${role} 输出包含 Markdown code fence，必须是纯 JSON`,
      role,
      truncate(raw),
    )
  }

  // 尝试解析 JSON
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    throw new OutcomeParseError(
      `[Outcome] ${role} 输出不是合法 JSON: ${truncate(trimmed)}`,
      role,
      truncate(raw),
    )
  }

  if (!isPlainObject(parsed)) {
    throw new OutcomeParseError(
      `[Outcome] ${role} 输出必须是 JSON 对象，收到 ${typeof parsed}`,
      role,
      truncate(raw),
    )
  }

  // 检查是否包含多个 JSON 对象（trimmed 中有多个顶层对象）
  try {
    // JSON.parse 会忽略后面的字符，但我们需要检测是否有多个对象
    const decoder = new JSONDecoder(trimmed)
    decoder.decode()
    if (decoder.hasMore()) {
      throw new OutcomeParseError(
        `[Outcome] ${role} 输出包含多个 JSON 对象，必须是单个对象`,
        role,
        truncate(raw),
      )
    }
  } catch (e) {
    if (e instanceof OutcomeParseError) throw e
    // 其他错误忽略，后续校验会处理
  }

  // 校验必需字段
  const obj = parsed as Record<string, unknown>

  if (typeof obj.outcome !== "string" || !VALID_OUTCOMES.includes(obj.outcome as OutcomeKind)) {
    throw new OutcomeParseError(
      `[Outcome] ${role} 的 outcome 字段必须是 ${VALID_OUTCOMES.join(" | ")}，收到: ${String(obj.outcome)}`,
      role,
      truncate(raw),
    )
  }

  if (typeof obj.summary !== "string") {
    throw new OutcomeParseError(
      `[Outcome] ${role} 缺少 summary 字段或 summary 不是字符串`,
      role,
      truncate(raw),
    )
  }

  const outcome = obj.outcome as OutcomeKind

  // needs_input 必须有 request
  if (outcome === "needs_input") {
    if (!isPlainObject(obj.request)) {
      throw new OutcomeParseError(
        `[Outcome] ${role} 的 outcome 为 needs_input 但缺少 request 字段`,
        role,
        truncate(raw),
      )
    }
    const req = obj.request as Record<string, unknown>
    if (typeof req.question !== "string") {
      throw new OutcomeParseError(
        `[Outcome] ${role} 的 request.question 必须是字符串`,
        role,
        truncate(raw),
      )
    }
    if (typeof req.allowFreeform !== "boolean") {
      throw new OutcomeParseError(
        `[Outcome] ${role} 的 request.allowFreeform 必须是布尔值`,
        role,
        truncate(raw),
      )
    }
    // 可选字段类型校验
    if (req.recommendation !== undefined && typeof req.recommendation !== "string") {
      throw new OutcomeParseError(
        `[Outcome] ${role} 的 request.recommendation 必须是字符串`,
        role,
        truncate(raw),
      )
    }
    if (req.inputHint !== undefined && typeof req.inputHint !== "string") {
      throw new OutcomeParseError(
        `[Outcome] ${role} 的 request.inputHint 必须是字符串`,
        role,
        truncate(raw),
      )
    }
    // options 数组校验
    if (req.options !== undefined) {
      if (!Array.isArray(req.options)) {
        throw new OutcomeParseError(
          `[Outcome] ${role} 的 request.options 必须是数组`,
          role,
          truncate(raw),
        )
      }
      for (let i = 0; i < req.options.length; i++) {
        const opt = req.options[i]
        if (!isPlainObject(opt)) {
          throw new OutcomeParseError(
            `[Outcome] ${role} 的 request.options[${i}] 必须是对象`,
            role,
            truncate(raw),
          )
        }
        if (typeof opt.id !== "string") {
          throw new OutcomeParseError(
            `[Outcome] ${role} 的 request.options[${i}].id 必须是字符串`,
            role,
            truncate(raw),
          )
        }
        if (typeof opt.label !== "string") {
          throw new OutcomeParseError(
            `[Outcome] ${role} 的 request.options[${i}].label 必须是字符串`,
            role,
            truncate(raw),
          )
        }
        if (opt.description !== undefined && typeof opt.description !== "string") {
          throw new OutcomeParseError(
            `[Outcome] ${role} 的 request.options[${i}].description 必须是字符串`,
            role,
            truncate(raw),
          )
        }
      }
    }

    // allowFreeform: false 时必须提供有效的 options
    if (!req.allowFreeform && (!Array.isArray(req.options) || req.options.length === 0)) {
      throw new OutcomeParseError(
        `[Outcome] ${role} 的 request.allowFreeform 为 false 时必须提供非空 options 数组`,
        role,
        truncate(raw),
      )
    }
  }

  // failed 必须有 failure
  if (outcome === "failed") {
    if (!isPlainObject(obj.failure)) {
      throw new OutcomeParseError(
        `[Outcome] ${role} 的 outcome 为 failed 但缺少 failure 字段`,
        role,
        truncate(raw),
      )
    }
    if (typeof (obj.failure as Record<string, unknown>).message !== "string") {
      throw new OutcomeParseError(
        `[Outcome] ${role} 的 failure.message 必须是字符串`,
        role,
        truncate(raw),
      )
    }
  }

  // 可选字段类型校验
  if (obj.report !== undefined && typeof obj.report !== "string") {
    throw new OutcomeParseError(
      `[Outcome] ${role} 的 report 必须是字符串`,
      role,
      truncate(raw),
    )
  }

  // 角色特定校验
  if (role === "implementer") {
    // implementer 不得伪造 review 结论
    if (obj.review !== undefined) {
      throw new OutcomeParseError(
        `[Outcome] implementer 不得输出 review 字段，review 结论应由 reviewer 给出`,
        role,
        truncate(raw),
      )
    }
  }

  if (role === "reviewer") {
    if (outcome === "completed") {
      // reviewer 的 completed 必须有 review
      if (!isPlainObject(obj.review)) {
        throw new OutcomeParseError(
          `[Outcome] reviewer 的 outcome 为 completed 但缺少 review 字段`,
          role,
          truncate(raw),
        )
      }
      const rev = obj.review as Record<string, unknown>
      if (typeof rev.verdict !== "string" || !VALID_VERDICTS.includes(rev.verdict as ReviewVerdict)) {
        throw new OutcomeParseError(
          `[Outcome] reviewer 的 review.verdict 必须是 ${VALID_VERDICTS.join(" | ")}，收到: ${String(rev.verdict)}`,
          role,
          truncate(raw),
        )
      }
      if (rev.cannotVerifySummary !== undefined && typeof rev.cannotVerifySummary !== "string") {
        throw new OutcomeParseError(
          `[Outcome] reviewer 的 review.cannotVerifySummary 必须是字符串`,
          role,
          truncate(raw),
        )
      }
    }
  }

  return obj as unknown as AgentOutcome
}

// ---- 简单 JSON 解码器（用于检测多个对象）----

class JSONDecoder {
  private pos = 0
  constructor(private readonly input: string) {}

  decode(): void {
    this.skipWhitespace()
    this.parseValue()
    this.skipWhitespace()
  }

  hasMore(): boolean {
    return this.pos < this.input.length
  }

  private skipWhitespace(): void {
    while (this.pos < this.input.length && /\s/.test(this.input[this.pos])) {
      this.pos++
    }
  }

  private parseValue(): void {
    this.skipWhitespace()
    const ch = this.input[this.pos]
    if (ch === '"') return this.parseString()
    if (ch === '{') return this.parseObject()
    if (ch === '[') return this.parseArray()
    if (ch === '-' || (ch >= '0' && ch <= '9')) return this.parseNumber()
    if (this.input.startsWith('true', this.pos)) { this.pos += 4; return }
    if (this.input.startsWith('false', this.pos)) { this.pos += 5; return }
    if (this.input.startsWith('null', this.pos)) { this.pos += 4; return }
    throw new Error(`Unexpected character at position ${this.pos}`)
  }

  private parseString(): void {
    this.pos++ // skip opening "
    while (this.pos < this.input.length) {
      if (this.input[this.pos] === '\\') {
        this.pos += 2
        continue
      }
      if (this.input[this.pos] === '"') {
        this.pos++
        return
      }
      this.pos++
    }
    throw new Error('Unterminated string')
  }

  private parseObject(): void {
    this.pos++ // skip {
    this.skipWhitespace()
    if (this.input[this.pos] === '}') { this.pos++; return }
    while (true) {
      this.parseString() // key
      this.skipWhitespace()
      this.pos++ // :
      this.parseValue()
      this.skipWhitespace()
      if (this.input[this.pos] === '}') { this.pos++; return }
      this.pos++ // ,
      this.skipWhitespace()
    }
  }

  private parseArray(): void {
    this.pos++ // skip [
    this.skipWhitespace()
    if (this.input[this.pos] === ']') { this.pos++; return }
    while (true) {
      this.parseValue()
      this.skipWhitespace()
      if (this.input[this.pos] === ']') { this.pos++; return }
      this.pos++ // ,
      this.skipWhitespace()
    }
  }

  private parseNumber(): void {
    if (this.input[this.pos] === '-') this.pos++
    while (this.pos < this.input.length && this.input[this.pos] >= '0' && this.input[this.pos] <= '9') this.pos++
    if (this.pos < this.input.length && this.input[this.pos] === '.') {
      this.pos++
      while (this.pos < this.input.length && this.input[this.pos] >= '0' && this.input[this.pos] <= '9') this.pos++
    }
    if (this.pos < this.input.length && (this.input[this.pos] === 'e' || this.input[this.pos] === 'E')) {
      this.pos++
      if (this.pos < this.input.length && (this.input[this.pos] === '+' || this.input[this.pos] === '-')) this.pos++
      while (this.pos < this.input.length && this.input[this.pos] >= '0' && this.input[this.pos] <= '9') this.pos++
    }
  }
}

// ---- 格式化 ----

/**
 * 将 AgentOutcome 格式化为 JSON 字符串。
 * 输出带缩进的 JSON，便于人类阅读。
 */
export const formatAgentOutcome = (outcome: AgentOutcome): string =>
  JSON.stringify(outcome, null, 2)

// ---- 用户决策 Broker 接口 ----

export type UserDecision = {
  optionId?: string
  text?: string
}

export type UserDecisionBroker = {
  /**
   * 当 agent 返回 needs_input 时调用。
   * 传递 sessionId、角色、原始请求和发起 turn 的 ID，返回用户决策。
   */
  requestDecision: (
    sessionId: string,
    role: AgentRole,
    request: InputRequest,
    turnId?: string,
  ) => Promise<UserDecision | null> // null 表示用户取消
}

/**
 * 创建一个 fake broker，用于测试。
 * 返回预设的决策列表，或默认返回第一个选项。
 */
export const createFakeUserDecisionBroker = (
  decisions?: UserDecision[],
): UserDecisionBroker & { callLog: Array<{ sessionId: string; role: AgentRole; request: InputRequest }> } => {
  const callLog: Array<{ sessionId: string; role: AgentRole; request: InputRequest }> = []
  let decisionIndex = 0

  return {
    callLog,
    requestDecision: async (sessionId, role, request) => {
      callLog.push({ sessionId, role, request })

      if (decisions && decisionIndex < decisions.length) {
        return decisions[decisionIndex++]
      }

      // 默认：选择第一个选项，或返回自由文本
      if (request.options && request.options.length > 0) {
        return { optionId: request.options[0].id }
      }
      return { text: "yes" }
    },
  }
}

