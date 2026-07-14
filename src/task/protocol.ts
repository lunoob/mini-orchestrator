import type { TaskRole } from "../types.js"
import { TASK_STATUSES_BY_ROLE } from "./constants.js"

export const buildTaskProtocol = (
  taskFilePath: string,
  runId: string,
  role: TaskRole,
  orchestratorMain: string,
) => {
  const statuses = TASK_STATUSES_BY_ROLE[role]

  return `
## 任务状态回报协议（编排器读取）

你必须通过 CLI 命令回报任务状态。编排器以此推进流程，不依赖 agent 面板状态。

- **任务文件**: \`${taskFilePath}\`
- **runId**: \`${runId}\`
- **角色**: ${role}

### 严格操作顺序

1. **开始工作前**，先执行：
   \`\`\`bash
   npx tsx "${orchestratorMain}" report-task --task "${taskFilePath}" --state started
   \`\`\`

2. **完成全部工作后**，按此顺序：
   a. 先输出完整最终结果（含 \`STATUS:\` 标记和结果分隔符）
   b. 再执行：
   \`\`\`bash
   npx tsx "${orchestratorMain}" report-task --task "${taskFilePath}" --state completed --status <你的状态>
   \`\`\`

   你的可用 status：
${statuses.map(s => `   - \`${s}\``).join("\n")}

⚠️ **关键**：必须在输出完整结果之后再回报 completed。回报后编排器会立即读取终端输出。
`
}
