import { beforeEach, describe, expect, it, vi } from "vitest";
import type { listWorkRuns } from "@/lib/work-runtime/queries";
import { readOwnerWorkshopRuns } from "@/lib/ai/chat/workshop-run-reader";
import { createWorkshopControlToolDefinitions } from "@/lib/ai/chat/workshop-control-tools";
import { createNativePiWebChatTools } from "@/lib/ai/native-pi-web-chat-tools";

const mocks = vi.hoisted(() => ({ listRuns: vi.fn(), context: vi.fn() }));
vi.mock("@/lib/work-runtime/queries", () => ({ listWorkRuns: mocks.listRuns }));
vi.mock("@/lib/work-runtime/chat-work-items", () => ({ readChatWorkshopContext: mocks.context }));
const ownerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", chatId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const workshopId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", firstId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const secondId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", thirdId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const at = new Date("2026-10-10T01:00:00Z");
function snapshot() {
  return { workshop: { id: workshopId, userId: ownerId, name: "强化学习前沿学习者", status: "paused", modelConfig: { privateConfig: true } },
    runs: [firstId, secondId, thirdId].map(id => ({ id, workshopId, status: "completed", outputSummary: "full output belongs to an exact read",
      createdAt: at, updatedAt: at, startedAt: at, completedAt: at })) } as unknown as NonNullable<Awaited<ReturnType<typeof listWorkRuns>>>;
}
const definition = () => createWorkshopControlToolDefinitions({ userId: ownerId, chatId }).find(tool => tool.name === "observeWorkshop")!;
beforeEach(() => { vi.clearAllMocks(); mocks.listRuns.mockResolvedValue(snapshot()); mocks.context.mockResolvedValue(null); });

describe("owned Workshop recent run discovery", () => {
  it("defaults to one recent run and leaves the full result to the exact reader", async () => {
    const result = await readOwnerWorkshopRuns({ ownerId, workshopId });
    expect(mocks.listRuns).toHaveBeenCalledExactlyOnceWith({ userId: ownerId, workId: workshopId, limit: 2 });
    expect(result.runs.map(run => run.id)).toEqual([firstId]);
    expect(result.coverage).toMatchObject({ limit: 1, hasMore: true, exhaustive: false });
  });
  it("preserves a source failure rather than manufacturing an empty run history", async () => {
    mocks.listRuns.mockRejectedValueOnce(Error("source unavailable"));
    await expect(readOwnerWorkshopRuns({ ownerId, workshopId })).rejects.toThrow("source unavailable");
  });
  it("reuses the owner-scoped query, retains its stable order and exposes exact result reads", async () => {
    const result = await readOwnerWorkshopRuns({ ownerId, workshopId, limit: 2 });
    expect(mocks.listRuns).toHaveBeenCalledExactlyOnceWith({ userId: ownerId, workId: workshopId, limit: 3 });
    expect(result.coverage).toEqual({ scope: "owner_workshop_recent_runs", order: "createdAt_desc_id_desc", limit: 2, hasMore: true, exhaustive: false });
    expect(result.runs.map(run => run.id)).toEqual([firstId, secondId]);
    expect(result.runs[0].nextRead).toEqual({ tool: "observeWorkshop", workshopId, runId: firstId, view: "result" });
    expect(result.runs[0]).not.toHaveProperty("outputSummary");
    expect(result.workshop).not.toHaveProperty("modelConfig");
  });
  it("makes a genuinely empty owned window explicit without calling it an execution failure", async () => {
    mocks.listRuns.mockResolvedValue({ ...snapshot(), runs: [] });
    expect(await readOwnerWorkshopRuns({ ownerId, workshopId })).toMatchObject({ ok: true, status: "runs_observed", runs: [], coverage: { hasMore: false, exhaustive: true } });
  });
  it.each(["missing", "different_owner", "different_workshop", "different_run_workshop"])("does not expose another owner's or mismatched run data: %s", async variant => {
    const stored = snapshot();
    if (variant === "different_owner") stored.workshop.userId = chatId;
    if (variant === "different_workshop") stored.workshop.id = chatId;
    if (variant === "different_run_workshop") stored.runs[0].workshopId = chatId;
    mocks.listRuns.mockResolvedValue(variant === "missing" ? null : stored);
    await expect(readOwnerWorkshopRuns({ ownerId, workshopId })).rejects.toMatchObject({ code: "workshop_run_not_found" });
  });
  it.each([0, 51, 1.5, Number.NaN])("rejects an invalid limit %s before reading", async limit => {
    await expect(readOwnerWorkshopRuns({ ownerId, workshopId, limit })).rejects.toMatchObject({ code: "workshop_runs_invalid_request" });
    expect(mocks.listRuns).not.toHaveBeenCalled();
  });
  it("rejects invalid identity before importing the query", async () => {
    await expect(readOwnerWorkshopRuns({ ownerId: "wrong", workshopId })).rejects.toMatchObject({ code: "workshop_runs_invalid_request" });
    expect(mocks.listRuns).not.toHaveBeenCalled();
  });
  it("registers runs discovery in the existing read adapter without needing a run ID or rebinding context", async () => {
    const tool = definition();
    expect(JSON.stringify(tool.parameters)).toContain('"runs"');
    const result = await tool.execute({ workshopId, view: "runs", limit: 2 }, { toolCallId: "read-runs" });
    expect(result).toMatchObject({ ok: true, status: "runs_observed", runs: [{ id: firstId }, { id: secondId }] });
    expect(mocks.context).toHaveBeenCalledExactlyOnceWith(ownerId, chatId);
    expect(mocks.listRuns).toHaveBeenCalledExactlyOnceWith({ userId: ownerId, workId: workshopId, limit: 3 });
  });
  it("uses only a bound Workshop for an omitted target and retains the original chat focus", async () => {
    const context = { workshopId, runId: secondId, workItemId: thirdId };
    mocks.context.mockResolvedValue(context);
    const result = await definition().execute({ view: "runs", limit: 2 }, { toolCallId: "read-bound-runs" });
    expect(result).toMatchObject({ runs: [{ id: firstId }, { id: secondId }] });
    expect(context).toEqual({ workshopId, runId: secondId, workItemId: thirdId });
  });
  it("requires Workshop discovery when neither explicit nor chat-bound target exists", async () => {
    expect(await definition().execute({ view: "runs" }, { toolCallId: "missing" })).toMatchObject({ ok: false, status: "target_missing" });
    expect(mocks.listRuns).not.toHaveBeenCalled();
  });
  it.each([{ runId: firstId }, { runId: "" }, { offset: 0 }, { expectedHash: "a".repeat(64) }])("refuses mixing run discovery and exact-result arguments: %j", async args => {
    await expect(definition().execute({ workshopId, view: "runs", ...args }, { toolCallId: "wrong-scope" })).rejects.toThrow("exact-result paging");
    expect(mocks.listRuns).not.toHaveBeenCalled();
  });
  it("does not silently ignore a discovery limit on an exact read", async () => {
    await expect(definition().execute({ workshopId, runId: firstId, view: "result", limit: 2 }, { toolCallId: "wrong-limit" })).rejects.toThrow("only supported");
    expect(mocks.listRuns).not.toHaveBeenCalled();
  });
  it("keeps the runtime denied policy ahead of run-list reads", async () => {
    const tools = createNativePiWebChatTools({ userId: ownerId, turnId: "run-list-turn",
      platformReadIdentity: { ownerId, requester: { kind: "chat", id: chatId }, turnId: "run-list-turn" }, policy: { deniedTools: ["observeWorkshop"] } });
    await expect(tools.find(tool => tool.name === "observeWorkshop")!.execute("denied-read", { workshopId, view: "runs" })).rejects.toThrow("denied");
    expect(mocks.context).not.toHaveBeenCalled(); expect(mocks.listRuns).not.toHaveBeenCalled();
  });
});
