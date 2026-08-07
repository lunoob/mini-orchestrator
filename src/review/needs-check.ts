import type { WorkflowEventBus } from "../workflow/events.js"

/**
 * yes/no 门卫：reviewer 输出 REVIEW_NEEDS_CHECK 后，通知用户去 reviewer pane 处理，
 * 完成后选 yes 继续（发 continuation 给 reviewer 重审），no 终止。
 */
export const promptNeedsCheckGate = async (
  round: number,
  eventBus: WorkflowEventBus,
): Promise<boolean> => {
  const result = await eventBus.requestInteraction({
    prompt: `Review round ${round}: Reviewer 需要人工核查。\n请到 reviewer pane 处理，完成后选择是否继续。`,
    agent: "reviewer",
    actions: ["yes", "no"],
  })
  return result.action === "yes"
}
