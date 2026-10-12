import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), resolve: vi.fn(), execute: vi.fn() }));
vi.mock("@/app/(auth)/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/ai/chat/native-workshop-run", () => ({
  resolveOwnerClickedWorkshopRun: mocks.resolve, executeNativeWorkshopRun: mocks.execute,
  NativeWorkshopRunError: class extends Error { constructor(readonly code: string, message: string, readonly status = 409) { super(message); } },
}));
vi.mock("@/lib/work-runtime/command-ledger", () => ({ WorkCommandConflict: class extends Error { readonly status = 409; constructor(readonly code: string) { super(code); } } }));
import { POST } from "@/app/api/workshops/run-from-chat/route";
import { NativeWorkshopRunError } from "@/lib/ai/chat/native-workshop-run";

const ownerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const chatId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const workshopId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const requestId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const runId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const body = { chatId, workshopId, requestId };
function request(value: unknown = body, headers: Record<string, string> = {}) {
  return new NextRequest("http://127.0.0.1:3515/api/workshops/run-from-chat", { method: "POST",
    headers: { "Content-Type": "application/json", Host: "127.0.0.1:3515", ...headers }, body: JSON.stringify(value) });
}
beforeEach(() => {
  vi.resetAllMocks(); mocks.auth.mockResolvedValue({ user: { id: ownerId } });
  mocks.resolve.mockResolvedValue({ ownerId, ...body });
  mocks.execute.mockResolvedValue({ ok: true, status: "run_accepted", workshop: { id: workshopId }, run: { id: runId, workshopId, status: "queued" } });
});
describe("owner button single-run endpoint", () => {
  it("binds the authenticated owner and queues one stable request without another confirmation", async () => {
    const response = await POST(request(body, { Origin: "http://127.0.0.1:3515", "X-Work-Actor": ownerId }));
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ ok: true, status: "run_accepted", run: { id: runId, status: "queued" } });
    expect(mocks.resolve).toHaveBeenCalledWith({ ownerId, chatId, workshopId, requestId });
    expect(mocks.execute).toHaveBeenCalledWith({ ownerId, ...body }, undefined, expect.any(AbortSignal));
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });
  it("rejects unauthenticated and mismatched actor requests before admission", async () => {
    mocks.auth.mockResolvedValue(null);
    expect((await POST(request())).status).toBe(401);
    mocks.auth.mockResolvedValue({ user: { id: ownerId } });
    expect((await POST(request(body, { "X-Work-Actor": "other-owner" }))).status).toBe(409);
    expect(mocks.resolve).not.toHaveBeenCalled(); expect(mocks.execute).not.toHaveBeenCalled();
  });
  it.each([null, [], { chatId }, { ...body, prompt: "replacement instruction" }, { ...body, commandId: "model-command" }, { ...body, ownerId }, { ...body, loopId: runId }])
    ("rejects altered action parameters %j", async input => {
      expect((await POST(request(input))).status).toBe(400);
      expect(mocks.resolve).not.toHaveBeenCalled(); expect(mocks.execute).not.toHaveBeenCalled();
    });
  it("preserves actual paused, busy and ownership failures without exposing a new run", async () => {
    for (const code of ["workshop_run_paused", "workshop_run_busy", "workshop_run_chat_not_owned"]) {
      mocks.resolve.mockRejectedValueOnce(new NativeWorkshopRunError(code, "无法新建运行。"));
      const response = await POST(request()); expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ ok: false, error: code });
    }
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it("returns the current completed state on a replay rather than rebranding it as queued", async () => {
    mocks.execute.mockResolvedValue({ ok: true, status: "run_accepted", replayed: true, run: { id: runId, workshopId, status: "completed", outputSummary: "真实报告" } });
    const response = await POST(request()); expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ replayed: true, run: { status: "completed", outputSummary: "真实报告" } });
  });
  it("returns accepted-but-unread explicitly without claiming completion", async () => {
    mocks.execute.mockResolvedValue({ ok: false, status: "run_readback_pending", runId, workshopId, retrySafe: true });
    const response = await POST(request()); expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: false, status: "run_readback_pending", runId });
  });
  it("does not trust a forwarded host or a cross-origin form submission", async () => {
    expect((await POST(request(body, { Origin: "http://another-site", "X-Forwarded-Host": "another-site" }))).status).toBe(403);
    expect((await POST(request(body, { "Content-Type": "text/plain" }))).status).toBe(400);
    expect(mocks.resolve).not.toHaveBeenCalled();
  });
});
