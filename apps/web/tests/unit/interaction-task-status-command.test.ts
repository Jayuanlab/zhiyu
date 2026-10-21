import { describe, expect, it, vi } from "vitest";
import { updateInteractionTaskStatusFromRead } from "@/lib/interactions/task-status-command";

function fixture(revision = 7) {
  const send = vi.fn(async (_command: unknown) => ({}));
  const refresh = vi.fn(async () => ({}));
  const createCommandId = vi.fn(() => "owner-command");
  const task = { id: "task-a", revision, metadata: { taskState: { version: 999 } } };
  const submit = () => updateInteractionTaskStatusFromRead({ id: task.id, status: "done", task, send, refresh, createCommandId });
  return { task, send, refresh, createCommandId, submit };
}

describe("interaction task status submission", () => {
  it("submits the database revision the owner read and refreshes after one command", async () => {
    const f = fixture();
    await f.submit();
    expect(f.send).toHaveBeenCalledExactlyOnceWith({ kind: "task", id: "task-a", status: "done", commandId: "owner-command", expectedVersion: 7 });
    expect(f.createCommandId).toHaveBeenCalledTimes(1);
    expect(f.refresh).toHaveBeenCalledTimes(1);
    expect(f.send.mock.invocationCallOrder[0]).toBeLessThan(f.refresh.mock.invocationCallOrder[0]);
  });

  it.each([undefined, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])("refreshes a missing or invalid version %s without sending", async revision => {
    const send = vi.fn(); const refresh = vi.fn(async () => ({}));
    const task = revision === undefined ? undefined : { id: "task-a", revision };
    await expect(updateInteractionTaskStatusFromRead({ id: "task-a", status: "done", task, send, refresh }))
      .rejects.toThrow("待办版本缺失，尚未提交更新；已刷新");
    expect(send).not.toHaveBeenCalled(); expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("refreshes a conflict without silently retrying against the newer revision", async () => {
    const f = fixture();
    f.send.mockRejectedValueOnce(Error("Task changed; refresh before acting"));
    f.refresh.mockImplementationOnce(async () => { f.task.revision = 8; return {}; });
    await expect(f.submit()).rejects.toThrow("已刷新待办当前状态，请核对后重试");
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.send.mock.calls[0][0]).toMatchObject({ expectedVersion: 7 });
    expect(f.refresh).toHaveBeenCalledTimes(1);
  });

  it("distinguishes a failed refresh from a refreshed current state", async () => {
    const f = fixture();
    f.send.mockRejectedValueOnce(Error("Task unavailable"));
    f.refresh.mockRejectedValueOnce(Error("offline"));
    await expect(f.submit()).rejects.toThrow("当前状态刷新失败");
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it("does not resend an accepted write when its refresh fails", async () => {
    const f = fixture();
    f.refresh.mockRejectedValueOnce(Error("offline"));
    await expect(f.submit()).rejects.toThrow("待办更新已提交，但当前状态刷新失败");
    expect(f.send).toHaveBeenCalledTimes(1); expect(f.refresh).toHaveBeenCalledTimes(1);
  });
});
