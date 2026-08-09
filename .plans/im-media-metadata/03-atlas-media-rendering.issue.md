# Atlas IM 媒体消息稳定布局与渐进预览

> 本文件供实现 agent 执行，不是讨论稿。实现时须加载 `test-driven-development` skill 并按 TDD 红-绿-重构循环完成。

## Purpose

让 Atlas IM 在不改动现有非虚拟化消息列表的前提下，使用 `waMessages.metadata` 首帧渲染稳定的图片、视频、音频与语音消息，并以渐进预览替代加载跳变和黑色视频块。

## Decision

本 issue 依赖 metadata 契约，但与 Atlas API 补全可并行开发。图片不保存专属 blur 文件：复用 Caprica `imageKey` 的低清 URL 与 CSS blur；视频使用 Atlas API 写入的 `posterImageKey`；音频使用 `waveformKey`。

## Depends on

- `.agent-plans/im-media-metadata/01-contract-and-ingest.issue.md` — 需要稳定 metadata 类型与状态语义。

## Background / 现状问题

- `apps/atlas/src/desktop/pages/common/chat/Messages.tsx` 使用普通 `ScrollDiv` 和全量 `map`，本任务明确不改虚拟滚动或分页。
- `ImAudioBubble.tsx` 与 `ImVideoBubble.tsx` 当前依赖浏览器 `loadedmetadata` 才显示时长；视频初始为黑色 `<video>`。
- `globus-next/src/components/Picture.tsx` 已实现 imageKey 的低清 Caprica 背景图 + CSS blur 策略，但 Atlas 为 Vite，不能直接依赖该 Next 组件。

## Goal

1. 图片、视频首帧有确定容器尺寸，避免媒体加载后改变消息列表高度。
2. 图片和视频先显示模糊预览，真实资源加载后平滑替换。
3. 音频/语音初始即显示准确时长与真实波形，不等待浏览器元数据加载。
4. pending/ready/failed 只改变消息气泡内部，不重置滚动位置或整条消息。

## Scope

### 包含

- 媒体 metadata 的前端读取、布局计算与状态呈现。
- 图片低清 blur、视频 poster blur、音频 waveform 读取与播放控件的 metadata 优先策略。
- Atlas 上传/发送过程中的本地乐观媒体预览与服务端确认衔接。

### 不包含

- 虚拟滚动或替换 `ScrollDiv`。
- 新消息列表数据源、历史回填、全局资源缓存架构重写。
- 媒体派生资源的服务端生成。

## 主要文件 / Suggested File Touch Points

- `apps/atlas/src/desktop/pages/common/chat/MessageText.tsx` — 将 metadata 传入各媒体 bubble。
- `apps/atlas/src/desktop/pages/common/chat/messageBubble/{ImImageBubble,ImVideoBubble,ImAudioBubble}.tsx` — 渐进渲染。
- `apps/atlas/src/desktop/pages/common/chat/messageBubble/MessageBubble.tsx`、`imMediaShape.ts` — 尺寸/圆角辅助（如需）。
- `apps/atlas/src/desktop/pages/projects/project/modules/IM/{IMChatMessagePane,buildImPendingFileMessage}.tsx`、`composerPendingAttachment.ts` — Atlas 主动发送的乐观 metadata。
- `apps/atlas/src/desktop/pages/common/chat/Messages.tsx` — 仅验证现有滚动锚点不被破坏，非重写。
- 相邻 `*.test.tsx` 与新增纯函数测试。

## 实现要求

1. `metadata.width/height` 为图片和视频计算确定的 aspect ratio；缺失且 pending 时使用统一的保守默认比例与固定边界，ready 后不允许外层消息气泡无提示跳变。
2. 图片 imageKey 的模糊预览复用 Caprica：`buildImageUrl(imageKey, { q: 10, w: 8, h: 8 })`，配合放大和 CSS blur；原图 load 后淡出预览。不要引入 BlurHash 或额外图片 preview 文件。
3. 视频在 poster 未就绪时显示固定比例骨架；有 `posterImageKey` 后先按与图片相同的 blur 策略显示 poster。原始 `<video>` 只能在 poster 覆盖下预加载，不能暴露黑块；播放后再显示真实视频。
4. `durationMs` 是展示和初始 seek 范围的唯一优先来源。`loadedmetadata` 只用于校验/更新播放进度，不应把初始标签从已知时长重置为 `00:00`。
5. 从 `waveformKey` 异步读取波形资源并绘制；加载前使用固定高度的骨架波形。不得再使用固定伪随机 `WAVE_HEIGHTS` 作为 ready 音频的最终波形。
6. `pending`：显示已知 metadata + 仅缺失部分的骨架；`failed`：保留尺寸与播放器结构，展示可理解的预览失败状态；两者均不可降级为普通文本消息。
7. Atlas 主动发送：本地 `File` 可立即提供宽高/时长用于乐观 UI；以现有 `recordId`/待发送消息关联服务端记录。服务端消息回写后平滑替换本地预览，保留播放状态和列表位置。
8. 限制图片/视频最大显示尺寸，处理极宽、极长和缺失尺寸，保持现有消息气泡视觉边界。

## TDD 实现方式

实现 agent **必须**：

1. 在开始写生产代码前，读取并遵循 `test-driven-development` skill。
2. 先写失败测试，再实现最小通过代码，最后重构。
3. 至少覆盖：
   - 已知宽高在资源未加载时仍产出稳定媒体容器；
   - `durationMs` 优先于 `<audio>/<video>` 的 `loadedmetadata`；
   - pending → ready 仅替换预览内容，不移除媒体气泡；
   - 视频有 poster 时首帧不显示黑色视频元素；
   - `waveformKey` 成功/失败时均保持固定播放器高度。

## 验收标准

1. 图片、视频在网络资源尚未完成时已有稳定高度；视频无黑色首帧闪现。
2. 图片与视频预览都先呈现低清模糊效果，原始资源加载后平滑显示。
3. 音频与语音在资源未完成下载时即展示 `durationMs` 和波形/骨架。
4. metadata 更新后不会重置当前会话的滚动位置、播放进度或整条消息组件。
5. 现有 IM 消息列表仍使用 `ScrollDiv`，未引入或改造虚拟滚动。

## 最终门禁

```bash
pnpm -w run build:lint --filter=atlas
```

