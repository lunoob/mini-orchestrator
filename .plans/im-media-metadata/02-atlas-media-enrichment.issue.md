# Atlas API 异步补全 IM 媒体派生资源

> 本文件供实现 agent 执行，不是讨论稿。实现时须加载 `test-driven-development` skill 并按 TDD 红-绿-重构循环完成。

## Purpose

实现 Atlas API 的异步媒体补全任务：只在 `waMessages.metadata` 缺失派生资源或可信 metadata 时，基于已转存原媒体生成 poster、waveform 与缺失信息并回写。

## Decision

本 issue 依赖媒体 metadata 契约。将重型/慢速媒体处理集中在已带 ffmpeg 的 Atlas API，避免让 Vercel 入站链路或三个自部署 API 等待或携带 ffmpeg。

## Depends on

- `.agent-plans/im-media-metadata/01-contract-and-ingest.issue.md` — 需要统一 metadata schema、内部原媒体引用与 pending 状态。

## Background / 现状问题

- Twilio URL 需要认证，Meta URL 会过期；补全服务不能直接依赖这些外部 URL。
- `apps/atlas-api/Dockerfile` 已安装 ffmpeg；可用于视频 poster、音视频时长与 waveform 解析。
- 图片原图为 imageKey 时，Atlas 前端可由 Caprica 动态生成低清模糊图，无需服务端再生成图片 thumbnail。
- 视频仍需要 `posterImageKey`；音频/语音需保存 `waveformKey`。

## Goal

1. 不阻塞 Vercel/API 入站与 Atlas 发送。
2. 每项任务只处理缺失的 metadata，不重复生成已有高质量资源。
3. 完成后安全、幂等地更新同一条 `waMessages` 并触发 Atlas 刷新。

## Scope

### 包含

- 受内部认证保护的任务投递与 Atlas API 消费入口，或复用仓库现有可靠异步队列模式。
- 从内部对象存储读取原媒体、生成派生资源、上传对象存储。
- metadata 的原子 patch、失败状态、可重试幂等性与失效通知。

### 不包含

- 重新下载 Twilio/Meta 的外部 URL。
- 图片 blur 文件生成；图片 imageKey 使用 Caprica 动态低清 URL。
- 历史全量回填、批量迁移或 UI 实现。

## 主要文件 / Suggested File Touch Points

- `apps/atlas-api/src/` 下新增/复用内部任务处理入口与媒体处理 helper。
- `apps/atlas-api/Dockerfile` — 仅验证现有 ffmpeg 可用；不引入新的重型运行时。
- `node-packages/db-tools/src/collections.ts`、`universal-packages/db-models/src/waMessage.ts` — 如任务类型/原子更新辅助所需。
- `apps/vercel-api/src/app/api/webhook/twilio/`、`apps/vercel-api/src/app/api/webhook/meta/whatsapp/` 与 `node-packages/api-trpc` 的投递点。
- `node-packages/api-trpc/src/query-helpers/imChat/max/bot/mediaUpload*.ts` — 参考既有异步媒体作业、幂等与完成通知模式。
- `apps/atlas-api` 与 `api-trpc` 的单元测试。

## 实现要求

1. 任务入参至少为 `waMessageId`；任务处理器自行读取当前消息，禁止信任调用方提供的 URL、尺寸或对象存储 key。
2. 仅在原媒体已转存并且 metadata 仍缺所需字段时执行。Twilio/Meta 上传未完成时不得运行；应等待现有上传完成信号或重新排队。
3. 图片：若 `body` 是有效 imageKey，补齐缺失的宽高即可；前端会以 `buildImageUrl(key, { q: 10, w: 8, h: 8 })` 获取模糊预览。不可额外存储图片 blur/thumbnail 文件。
4. 视频：用现有 ffmpeg 生成可由 Caprica 访问的 `posterImageKey`；补齐缺失宽高和 `durationMs`，但不覆盖渠道已给出的有效值。
5. 音频/语音：补齐缺失 `durationMs`；将 waveform 以稳定、版本化格式保存为对象存储资源，并写入 `waveformKey`。渠道直接提供 waveform 时优先规范化并持久化它，无须重新分析音频；没有时才从原媒体生成。
6. 确定资源命名、MIME、大小限制和临时文件清理策略；不可将完整媒体读入无界内存。
7. 使用 compare-and-set/条件更新，保证：重复投递、并发处理与历史同步均不会覆盖更完整 metadata；成功后将 status 置 ready，永久不可恢复错误置 failed 并保留已成功字段。
8. 成功或最终失败后触发现有 `waMessages` 失效/更新机制，使 Atlas 不刷新整页也能收到新 metadata。
9. 所有外部调用失败必须可观察（结构化日志含 message id、平台、失败阶段），不得泄露媒体 URL、认证令牌或内容。

## TDD 实现方式

实现 agent **必须**：

1. 在开始写生产代码前，读取并遵循 `test-driven-development` skill。
2. 先写失败测试，再实现最小通过代码，最后重构。
3. 至少覆盖：
   - ready metadata 不触发再次生成；
   - 视频补全 poster/时长/尺寸且保留渠道原值；
   - 有来源 waveform 时不运行音频解析，仍写入 waveformKey；
   - 上传未完成、重复任务、解析失败分别不会破坏消息或无限重试。

## 验收标准

1. Twilio/Meta 媒体在原媒体转存后可异步获得完整 metadata；任务不访问临时/受鉴权外部 URL。
2. 视频 metadata 最终含可渲染 `posterImageKey`；音频/语音最终含 `waveformKey` 与 `durationMs`。
3. 图片 imageKey 不生成重复 preview 文件，前端所需低清 URL 可由 Caprica 动态构造。
4. 并发或重复任务不能丢失、回退或覆盖已有 metadata。
5. 任务成功/失败后 Atlas 的消息查询可观察到最新状态。

## 最终门禁

```bash
pnpm -w run build:lint --filter=globus-api
pnpm -w run build:lint --filter=@globus/api-trpc
pnpm -w run build:lint --filter=vercel-api
```

