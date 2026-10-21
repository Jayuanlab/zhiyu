export type InteractionTaskStatusCommand = {
  kind: "task";
  id: string;
  status: string;
  commandId: string;
  expectedVersion: number;
};

/** Submit exactly the version the owner saw; refresh failures never resend the command. */
export async function updateInteractionTaskStatusFromRead(input: {
  id: string;
  status: string;
  task: { id: string; revision: number } | undefined;
  send: (command: InteractionTaskStatusCommand) => Promise<unknown>;
  refresh: () => Promise<unknown>;
  createCommandId?: () => string;
}) {
  try {
    const revision = input.task?.revision;
    if (input.task?.id !== input.id || typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) {
      throw new Error("待办版本缺失，尚未提交更新");
    }
    await input.send({
      kind: "task", id: input.id, status: input.status,
      commandId: (input.createCommandId ?? (() => crypto.randomUUID()))(),
      expectedVersion: revision,
    });
  } catch (error) {
    let refreshed = false;
    try { await input.refresh(); refreshed = true; } catch { /* Keep the original command failure visible. */ }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${detail}；${refreshed ? "已刷新待办当前状态，请核对后重试" : "当前状态刷新失败，请刷新页面后核对"}`);
  }
  try {
    await input.refresh();
  } catch {
    throw new Error("待办更新已提交，但当前状态刷新失败，请刷新页面后核对");
  }
}
