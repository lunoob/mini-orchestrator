# IM 媒体 metadata 契约与五渠道接入

> 本文件供实现 agent 执行，不是讨论稿。实现时须加载 `test-driven-development` skill 并按 TDD 红-绿-重构循环完成。

## Purpose

为 `waMessages` 建立统一的媒体 metadata 契约，并让 chat-api、telegram-api、max-api、Twilio、Meta 以及 Atlas 主动发送路径在消息首次落库时写入可获得的 metadata。

## Decision

本任务拆为三个 issue。本 issue 是后续 Atlas API 补全与 Atlas UI 的共享数据契约，必须先完成；五个渠道的写入点与模型高度耦合，不能拆成会留下半成品的独立平台任务。

## Background / 现状问题

- `universal-packages/db-models/src/waMessage.ts` 已有 `mimeType`、`fileSize`、`filename`，但没有媒体尺寸、时长、预览与波形的统一字段。
- Atlas 当前以浏览器 `loadedmetadata` 决定音视频时长；图片、视频没有可在首帧使用的稳定布局数据。
- 原始消息样本位于 `.messages/`，确认的渠道能力如下：
  - chat-api（`apps/whatsapp`）：raw data 有图片/视频宽高、秒级时长、语音 waveform。
  - telegram-api：`@mtcute` 有图片/视频宽高、时长、缩略图；语音有 waveform。
  - max-api：附件有图片/视频宽高、视频/语音毫秒时长；音乐文件为 `FILE + preview._type === MUSIC + preview.duration`。
  - Twilio 与 Meta webhook 只有类型、MIME、外部媒体 URL/ID，须等待异步补全。

## Goal

1. 每条 `image`、`video`、`audio`、`ptt` 消息都有 `metadata`；文本、`file`、`document` 不写该字段。
2. 首次写入同步保存渠道已提供的尺寸、时长和可下载预览信息。
3. 缺失派生资源或不可信字段时标记 `pending`，供后续补全；不得阻塞入站消息可见或平台发送。
4. Atlas 主动发送媒体也按同一契约写入初始 metadata。

## Scope

### 包含

- `waMessages.metadata` 的 Zod/TypeScript 模型与传输契约。
- 五条渠道的入站、历史同步和 Atlas 出站写入路径。
- 初始状态、幂等合并与“只补缺失字段”规则。

### 不包含

- 生成视频 poster、图片预览或 waveform 文件（见 `02-atlas-media-enrichment.issue.md`）。
- Atlas 消息气泡 UI 改造（见 `03-atlas-media-rendering.issue.md`）。
- 虚拟滚动、消息列表分页或历史数据全量回填。

## 主要文件 / Suggested File Touch Points

- `universal-packages/db-models/src/waMessage.ts` — metadata schema。
- `universal-packages/@types/chat-types/index.d.ts` — chat-api 的标准消息传输字段。
- `apps/whatsapp/src/main/message.ts` — WhatsApp raw data 映射。
- `apps/telegram-api/src/helpers/message.ts` — `@mtcute` media 映射与平台缩略图描述。
- `apps/max-api/src/converters/{attachment,message,types}.ts`、`apps/max-api/src/helpers/{inbound,media}.ts` — Max 映射。
- `node-packages/api-trpc/src/query-helpers/imChat/{telegram,max}/persistMessage.ts`、`query-helpers/whatsapp/message.ts` — `waMessages` 持久化。
- `node-packages/api-trpc/src/query-helpers/whatsapp/synchronous/syncTwilioHistory.ts`、Twilio/Meta webhook 持久化相关路径 — 外部渠道初始状态。
- `node-packages/api-trpc/src/routers/waMessages.ts`、`apps/atlas/src/desktop/pages/projects/project/modules/IM/{IMChatMessagePane,buildImPendingFileMessage}.tsx` — Atlas 主动发送的初始 metadata。
- 对应 workspace 的单元测试文件；新增契约/转换测试。

## 实现要求

1. 在 `WaMessage` 上新增可选 `metadata`，仅允许媒体类型写入。字段至少包括：
   - `status`: `pending | ready | failed`；
   - `width`、`height`（正整数）；
   - `durationMs`（非负毫秒）；
   - `posterImageKey`（视频 poster）；
   - `waveformKey`（音频/语音 waveform 资源）；
   - 为补全任务保留的、可安全清理的来源信息（例如平台原始 waveform 或可下载 thumbnail 描述）。前端不得依赖这些来源信息。
2. `mimeType`、`fileSize`、`filename` 继续使用现有顶层字段，不重复写入 metadata。
3. 标准化单位：所有 `durationMs` 都为毫秒。chat-api/Telegram 的秒或浮点秒必须转换；chat-api 中 `duration === "0"` 视为未知，不可写为有效时长。
4. chat-api：从 raw data 写入图片/视频宽高、可信时长和语音 waveform 来源数据。
5. telegram-api：使用高层 `Photo/Video/Audio/Voice` 字段，而不是直接耦合 TL 私有数组；传递图片/视频尺寸、时长、语音 waveform 与可下载 thumbnail 来源。
6. max-api：映射 `attachments[0].width/height/duration`；`FILE` 且 `preview._type === "MUSIC"` 必须规范化为 `audio` 并从 `preview.duration` 转为毫秒。样本没有 Max thumbnail/waveform 时保持 pending。
7. Twilio、Meta：先写可得的 MIME、媒体类型与内部原媒体引用；metadata 必须是 pending，不能把受鉴权或会过期的外部 URL 当作 Atlas UI/补全任务的稳定资源。
8. Atlas 出站：不等待派生资源生成。前端可为乐观预览读取本地文件信息；服务端落库的 metadata 是最终可信版本。失败与重试沿用同一条消息的 metadata。
9. 所有 upsert/历史同步必须合并 metadata：新值只能补全或提高质量，不能清空既有 `width`、`durationMs`、`posterImageKey`、`waveformKey` 或将 ready 回退为 pending。
10. 写入 pending 后投递补全任务的接口由 Issue 02 提供；本 issue 只在契约层预留调用点，禁止同步等待媒体解析。

## TDD 实现方式

实现 agent **必须**：

1. 在开始写生产代码前，读取并遵循 `test-driven-development` skill。
2. 先写失败测试，再实现最小通过代码，最后重构。
3. 至少覆盖：
   - chat-api 秒级时长、`"0"` 时长和语音 waveform 的标准化；
   - Telegram 图片/视频/语音的尺寸、时长、thumbnail/waveform 映射；
   - Max `MUSIC` 文件转为 audio 与秒→毫秒转换；
   - 重复 webhook/历史同步不能降低已完成 metadata。

## 验收标准

1. `WaMessage` 的运行时 schema 与 TypeScript 类型均能表达媒体 metadata，非媒体不产生该字段。
2. `.messages/` 中 chat-api、telegram-api、max-api 的图片、视频、音频、语音样本均按上述规则转换。
3. Twilio/Meta 首次持久化的媒体消息有 `metadata.status = pending`，且补全任务仅能引用已转存资源。
4. Atlas 主动发出的媒体消息在落库时已带 metadata（至少 pending 与可同步取得的布局信息）。
5. 重放同一消息不会删除或降级已有 metadata。

## 最终门禁

```bash
pnpm -w run build:lint --filter=@globus/db-models
pnpm -w run build:lint --filter=@globus/api-trpc
pnpm -w run build:lint --filter=whatsapp
pnpm -w run build:lint --filter=telegram
pnpm -w run build:lint --filter=max-api
pnpm -w run build:lint --filter=vercel-api
```

