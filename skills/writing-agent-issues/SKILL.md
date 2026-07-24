---
name: writing-agent-issues
description: >-
  根据当前讨论或 PRD，产出可供其他 agent 直接执行的 issue 文档，判断是否需要拆分为多个 issue，
  并写入项目 .agent-plans/<task-slug>/ 子目录。每个 issue 须要求 TDD 实现并引用 test-driven-development skill。
  在用户要求输出 issue、拆分任务、写 agent 可执行计划、或讨论结束后要交给实现 agent 时使用。
disable-model-invocation: true
---

# Write Agent Issues

将当前对话中的结论、PRD、设计决策转化为**实现 agent 可直接执行**的 issue 文档。

本 skill 只负责写 issue，不负责实现代码、写测试、做 code review 或提交 PR。

---

## 1. 目标

产出一份或多份 **Agent-Ready Issue**，让后续实现 agent 无需重开讨论即可开工：

- 知道做什么、不做什么
- 知道改哪些文件、优先顺序
- 知道验收标准与门禁命令
- 知道必须用 TDD 实现

issue 不是讨论稿，不是 PRD 复述，而是**可执行的实现说明**。

---

## 2. 非职责

- 不实现功能、不写生产代码
- 不代替实现 agent 跑测试或 lint
- 不把 issue 写成开放式 brainstorm
- 不擅自扩大讨论中已确认的范围
- 若信息不足以写出可执行 issue，先向用户澄清，而不是用模糊措辞凑文档

---

## 3. 何时拆分多个 issue

先判断：**一个 agent 能否在单次会话内，按清晰依赖顺序独立完成并验收？**

### 默认：一个 issue

满足以下多数条件时，写 **1 个 issue**：

- 同一功能域、同一验收闭环
- 改动文件高度耦合，拆开会导致半成品无法验收
- 核心是单一重构或单一 bug 修复
- 前后端改动属于同一用户可见结果

### 应拆成多个 issue

出现以下情况时，拆成 **2 个及以上 issue**，并写明依赖顺序：

| 信号 | 示例 |
|------|------|
| 独立可交付边界 | 后端 API 改造 vs 前端接入，可分别验收 |
| 不同子系统 / 包 | `api-trpc` 与 `atlas` 可并行但应分 issue |
| 明显阶段性目标 | V1 骨架对齐 → V2 差异高亮 → V3 编辑态增强 |
| 风险隔离 | 数据迁移与 UI 改造分开 |
| 体量过大 | 预计涉及 8+ 文件且含 model + UI + API 三层 |
| 非目标里写了 follow-up | 主 issue 只做 V1，后续能力单独成 issue |

### 拆分写法

- 每个 issue **自包含**：单独阅读也能开工
- 用 `## Depends on` 或 `## Blocks` 标明顺序
- 主 issue 的 `## Non-goals` 或 `## Follow-up Issues` 列出后续 issue 标题与文件名
- 同一任务下的多个 issue 放在**同一任务目录**内，文件名用序号或语义区分，例如：
  - `.agent-plans/feature-redesign/api-contract.issue.md`
  - `.agent-plans/feature-redesign/ui-wiring.issue.md`

在 issue 正文开头用简短 `## Decision` 说明：**为何拆 / 为何不拆**。

**告知用户执行顺序**：拆分后，在回复向用户说明各 issue 的推荐执行顺序与串/并行判断依据。例如：

> 「共拆为 3 个 issue，推荐顺序：① api-contract → ② ui-wiring → ③ e2e-integration。其中 ① ② 可并行开发但 ③ 必须等前两者完成。」

---

## 4. 工作流程

### Step 1: 收集输入

从以下来源提取已确认事实（按优先级）：

1. 当前对话中的结论、用户明确决策
2. 用户提供的 PRD（如 `.agent-prds/**/prd.md`）
3. 用户点名的文件、路由、行为、截图描述
4. 仓库内已有代码事实（只读查证，不扩 scope）

缺失的高影响信息（目标行为、非目标、验收标准）未澄清时，**最多问 1 个聚焦问题**；低风险细节写入 `## Assumptions`。

### Step 2: 决定 issue 数量

按第 3 节规则做出拆分决策，并在回复中一句话说明理由。

### Step 3: 写入文件

在项目根目录的 `.agent-plans/` 下，**先创建与本次任务相关的子目录**，再将 issue 文档写入该目录。

**目录与命名：**

```
.agent-plans/<task-slug>/
  <issue-slug>.issue.md
```

- `task-slug`：本次任务/主题的统一目录名，kebab-case，简短语义化（例如 `extract-products-review-card-redesign`）
- 同一批拆分的多个 issue **共用同一** `task-slug` 目录
- `issue-slug`：单个 issue 的文件名主体；仅 1 个 issue 时可用 `issue.issue.md` 或与 `task-slug` 同名的 `<task-slug>.issue.md`
- 多 issue 时在目录内用后缀区分：`api-contract.issue.md`、`ui-wiring.issue.md`
- 仅当用户明确要求日期前缀时才在 `task-slug` 前加 `YYYY-MM-DD-`
- 目录不存在时先创建，不要把 issue 直接平铺在 `.agent-plans/` 根下

**文件头说明（每个 issue 必须有）：**

```md
> 本文件供实现 agent 执行，不是讨论稿。实现时须加载 `test-driven-development` skill 并按 TDD 红-绿-重构循环完成。
```

若无法写文件，在回复中输出完整 issue 正文，并说明未持久化。

### Step 4: 自查

用第 6 节 checklist 过一遍，然后向用户说明：

- issue 存放路径
- issue 数量及推荐执行顺序
- 是否建议拆成多 agent 串行执行

---

## 5. Issue 文档模板

每个 issue 使用以下结构（可按任务删减小节，但 **目标、范围、实现要求、验收标准、TDD、门禁** 不可缺）：

```md
# <Issue 标题>

> 本文件供实现 agent 执行，不是讨论稿。实现时须加载 `test-driven-development` skill 并按 TDD 红-绿-重构循环完成。

## Purpose

一句话说明这份文档给谁用、要达成什么。

## Decision（可选但推荐）

说明本 issue 是否从更大任务拆分而来，以及拆/不拆的理由。

## Depends on（仅多 issue 时）

- 需先完成：`.agent-plans/<task-slug>/<other-issue-slug>.issue.md` — 原因

## Background / 现状问题

- 当前行为是什么
- 问题或动机是什么
- 已调查确认的事实（含路径、字段、复现条件）

## Goal

可验证的目标列表。

## Scope

### 包含

- ...

### 不包含（Non-goals）

- ...

## 主要文件 / Suggested File Touch Points

- `path/to/file.ts` — 改什么
- 测试文件建议路径（若适用）

## 实现要求

分编号说明具体行为、约束、边界。避免「优化一下」「处理好」等空话。

## TDD 实现方式

实现 agent **必须**：

1. 在开始写生产代码前，Read 并遵循 `test-driven-development` skill（`~/.agents/skills/test-driven-development/SKILL.md` 或工作区等价路径）
2. 先为本次变更的核心行为编写失败测试，确认失败后再实现
3. 优先测 model / selector / 纯函数与 API 契约；UI 行为以可稳定断言的层为主
4. 在 issue 涉及的行为范围内，不跳过「先红后绿」

建议在本节列出**至少 2–3 条**建议覆盖的测试场景（不是完整测试代码）。

## 验收标准

编号 checklist，全部满足才算完成。

## 建议验证

手动或集成验证场景（若有）。

## 最终门禁

提交前须通过的命令，例如 Globus monorepo：

```bash
pnpm -w run build:lint --filter=<workspace-name>
```

## Follow-up Issues（可选）

后续可拆的独立 issue 标题与建议文件名。
```

---

## 6. 质量标准（自查）

- [ ] issue 文件位于 `.agent-plans/<task-slug>/` 子目录内，未平铺在 `.agent-plans/` 根下
- [ ] 已明确 **包含 / 不包含**
- [ ] 验收标准可观察、可判定，无「体验更好」类空话
- [ ] 文件路径具体；不确定处标为「待实现 agent 确认」并说明查找方向
- [ ] 已判断拆 issue，且 `Decision` 或回复中说明了理由
- [ ] 每个 issue 都包含 **TDD 实现方式** 小节，并指向 `test-driven-development` skill
- [ ] 多 issue 时依赖顺序清楚
- [ ] 已告知用户多 issue 的执行顺序与串/并行判断依据
- [ ] 未把 PRD 整段粘贴进 issue；只保留与实现相关的决策与事实

---

## 7. 与 PRD Agent 的关系

- `prd-agent` 产出 PRD → 用户确认后，可用本 skill 拆 issue
- 若用户跳过 PRD、直接在讨论中定方案，本 skill 可直接从对话产出 issue
- issue 粒度细于 PRD：要有文件触点、实现约束、测试场景、lint 门禁

---

## 8. 完成后提示

issue 写入后，用中文告知用户，并在多 issue 时说明推荐执行顺序：

```md
已在 `.agent-plans/<task-slug>/` 写好实现 issue（共 N 个）：
- `.agent-plans/<task-slug>/<issue-slug>.issue.md`
- …

推荐执行顺序：① → ② → …（或说明哪些可并行 / 哪些须串行）。

请将 issue 交给实现 agent；实现时须加载 `test-driven-development` skill。
若需调整范围或拆分方式，说明后我可更新 issue 文档。
```

不要自动开始实现，除非用户明确要求。
