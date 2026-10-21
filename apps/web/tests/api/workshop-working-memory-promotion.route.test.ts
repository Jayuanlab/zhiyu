import { beforeEach, describe, expect, it, vi } from "vitest";
import { loopPromotionEvents, promotionEvents, promotionLoopId, promotionRunId, promotionUserId, promotionWorkId } from "../fixtures/working-memory-promotion";
import type { BrainMemory } from "@/lib/memory/kernel/memory-types";
import type { createMemoryCandidate as createBrainMemoryCandidate } from "@/lib/memory/revision/writes";
import { withExecutionContext } from "@/lib/work-runtime/execution-context";

const state = vi.hoisted(() => ({ user: null as null | { id: string } }));
const deps = vi.hoisted(() => ({ getWorkshop: vi.fn(), listWorkshopEvents: vi.fn(), appendWorkshopEvent: vi.fn(),
  createBrainMemoryCandidate: vi.fn(), getBrainMemory: vi.fn(), readOwnerWorkshopRun: vi.fn(), readOwnerLoopRun: vi.fn() }));
vi.mock("@/app/(auth)/auth", () => ({ auth: async () => state.user ? { user: state.user } : null }));
vi.mock("@/lib/workshops/service", () => ({ getWorkshop: deps.getWorkshop, listWorkshopEvents: deps.listWorkshopEvents, appendWorkshopEvent: deps.appendWorkshopEvent }));
vi.mock("@/lib/memory/revision/writes", () => ({ createMemoryCandidate: deps.createBrainMemoryCandidate }));
vi.mock("@/lib/memory/adapters/postgres/memory-records", () => ({ getMemoryById: deps.getBrainMemory }));
vi.mock("@/lib/brain/workshop-memory", () => ({ createWorkshopBrainRequester: (workshop: any) => ({ type: "work", userId: workshop.userId, id: workshop.id, workshopId: workshop.id }) }));
vi.mock("@/lib/workshops/working-memory-promotion-receipt", () => ({ appendOwnerWorkingMemoryPromotion: async ({ event }: { event: unknown }) => deps.appendWorkshopEvent(event) }));
vi.mock("@/lib/ai/chat/native-workshop-run", () => ({ readOwnerWorkshopRun: deps.readOwnerWorkshopRun,
  NativeWorkshopRunError: class NativeWorkshopRunError extends Error {} }));
vi.mock("@/lib/loops/owner-loop-run", () => ({ readOwnerLoopRun: deps.readOwnerLoopRun,
  OwnerLoopRunError: class OwnerLoopRunError extends Error { code = "loop_run_not_found"; status = 404; } }));

const body = () => ({ runKind: "workshop", runId: promotionRunId, noteKey: "paper:method", expectedVersion: 1, commandId: "promotion-1" });
const loopBody = () => ({ ...body(), runKind: "loop", loopId: promotionLoopId });
function candidate(input: Parameters<typeof createBrainMemoryCandidate>[0]): Awaited<ReturnType<typeof createBrainMemoryCandidate>> {
  return { id: input.id!, userId: input.requester.userId, ownerType: input.ownerType, ownerId: input.ownerId, scope: input.scope,
    memoryType: input.memoryType, subject: input.subject, content: input.content, confidence: input.confidence ?? 50, status: "candidate",
    evidenceRefs: input.evidenceRefs ?? [], createdAt: "2026-10-13T00:00:00.000Z", updatedAt: "2026-10-13T00:00:00.000Z", metadata: input.metadata } satisfies BrainMemory;
}
async function submit(value: unknown = body()) {
  const { POST } = await import("@/app/api/workshops/[id]/working-memory/promote/route");
  return POST(new Request("http://localhost/api/workshops/work/working-memory/promote", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) }),
    { params: Promise.resolve({ id: promotionWorkId }) });
}

describe("owner working memory promotion route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.user = { id: promotionUserId };
    deps.getWorkshop.mockResolvedValue({ id: promotionWorkId, userId: promotionUserId, name: "Research" });
    deps.listWorkshopEvents.mockImplementation(async () => promotionEvents());
    deps.readOwnerWorkshopRun.mockResolvedValue({ run: { status: "completed" } });
    deps.readOwnerLoopRun.mockResolvedValue({ run: { status: "success", completedAt: "2026-10-16T00:00:00.000Z" } });
    deps.createBrainMemoryCandidate.mockImplementation(async input => candidate(input));
    deps.getBrainMemory.mockResolvedValue(null);
    deps.appendWorkshopEvent.mockResolvedValue({ id: "receipt" });
  });
  it("requires owner authentication and ownership before reading run notes", async () => {
    state.user = null;
    expect((await submit()).status).toBe(401);
    expect(deps.getWorkshop).not.toHaveBeenCalled();
    state.user = { id: promotionUserId }; deps.getWorkshop.mockResolvedValue(null);
    expect((await submit()).status).toBe(404);
    expect(deps.listWorkshopEvents).not.toHaveBeenCalled();
    expect(deps.createBrainMemoryCandidate).not.toHaveBeenCalled();
  });
  it("does not let a running worker submit a candidate through an inherited owner API context", async () => {
    const response = await withExecutionContext({ userId: promotionUserId, workshopId: promotionWorkId, runId: promotionRunId, workerId: "worker", token: 1 }, () => submit());
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("owner_promotion_required");
    expect(deps.createBrainMemoryCandidate).not.toHaveBeenCalled();
    expect(deps.appendWorkshopEvent).not.toHaveBeenCalled();
  });
  it.each(["running", "queued", "needs_review", "paused"])("rejects nonterminal %s runs without creating a candidate", async status => {
    deps.readOwnerWorkshopRun.mockResolvedValue({ run: { status } });
    const response = await submit();
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("working_memory_run_not_terminal");
    expect(deps.listWorkshopEvents).not.toHaveBeenCalled();
    expect(deps.createBrainMemoryCandidate).not.toHaveBeenCalled();
  });
  it("creates only a candidate through Brain admission and records exact receipt identities", async () => {
    const response = await submit(), payload = await response.json();
    expect(response.status).toBe(201);
    expect(payload).toMatchObject({ ok: true, status: "candidate", replayed: false });
    expect(deps.createBrainMemoryCandidate).toHaveBeenCalledOnce();
    const input = deps.createBrainMemoryCandidate.mock.calls[0][0];
    expect(input).toMatchObject({ requester: { type: "work", id: promotionWorkId, userId: promotionUserId }, ownerType: "work", ownerId: promotionWorkId,
      content: "来源只覆盖第一段，结论仍需核验。", scope: { type: "work", workId: promotionWorkId }, evidenceRefs: [promotionEvents()[0].id] });
    expect(input).not.toHaveProperty("status");
    expect(input.metadata.workingMemoryPromotion).toMatchObject({ authority: "model-authored-unverified", status: "pending_owner_review", expectedVersion: 1 });
    expect(input.metadata.workingMemoryPromotion.sources[0]).toMatchObject({ span: { offset: 0, contentLength: 1000, totalChars: 2000 } });
    expect(deps.appendWorkshopEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "working_memory_promoted",
      metadata: expect.objectContaining({ status: "candidate", candidateId: payload.candidateId }) }));
    expect(deps.readOwnerWorkshopRun).toHaveBeenCalledTimes(2);
  });
  it("uses the exact Loop owner reader and Loop event filter, preserving the execution run identity", async () => {
    deps.listWorkshopEvents.mockResolvedValue(loopPromotionEvents());
    const response = await submit(loopBody());
    expect(response.status).toBe(201);
    expect(deps.readOwnerWorkshopRun).not.toHaveBeenCalled();
    expect(deps.readOwnerLoopRun).toHaveBeenCalledWith({ ownerId: promotionUserId, workshopId: promotionWorkId, loopId: promotionLoopId, runId: promotionRunId });
    expect(deps.listWorkshopEvents).toHaveBeenCalledWith(promotionWorkId, { loopRunId: promotionRunId, order: "asc", limit: 2001 });
    expect(deps.appendWorkshopEvent).toHaveBeenCalledWith(expect.objectContaining({ loopId: promotionLoopId, loopRunId: promotionRunId,
      runId: loopPromotionEvents()[0].runId }));
    expect(deps.createBrainMemoryCandidate.mock.calls[0][0].metadata.workingMemoryPromotion).toMatchObject({
      runIdentity: { runKind: "loop", loopId: promotionLoopId, runId: promotionRunId }, status: "pending_owner_review" });
  });
  it.each(["queued", "running", "needs_review", "needs_approval", "paused"])("rejects a nonterminal Loop %s without falling back to workshop_runs", async status => {
    deps.readOwnerLoopRun.mockResolvedValue({ run: { status, completedAt: "2026-10-16T00:00:00.000Z" } });
    const response = await submit(loopBody());
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("working_memory_run_not_terminal");
    expect(deps.readOwnerWorkshopRun).not.toHaveBeenCalled();
    expect(deps.listWorkshopEvents).not.toHaveBeenCalled();
    expect(deps.createBrainMemoryCandidate).not.toHaveBeenCalled();
  });
  it("rejects a Loop with no finalized completion timestamp", async () => {
    deps.readOwnerLoopRun.mockResolvedValue({ run: { status: "success", completedAt: null } });
    expect((await submit(loopBody())).status).toBe(409);
    expect(deps.createBrainMemoryCandidate).not.toHaveBeenCalled();
  });
  it("never falls back to a same-ID workshop run when Loop ownership lookup fails", async () => {
    const { OwnerLoopRunError } = await import("@/lib/loops/owner-loop-run");
    deps.readOwnerLoopRun.mockRejectedValue(new OwnerLoopRunError("loop_run_not_found", "not found"));
    expect((await submit(loopBody())).status).toBe(404);
    expect(deps.readOwnerWorkshopRun).not.toHaveBeenCalled();
    expect(deps.createBrainMemoryCandidate).not.toHaveBeenCalled();
  });
  it("keeps Loop admission idempotent after a persisted candidate and failed final receipt", async () => {
    deps.listWorkshopEvents.mockResolvedValue(loopPromotionEvents());
    deps.appendWorkshopEvent.mockRejectedValueOnce(Error("store unavailable"));
    const warning = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await submit(loopBody())).status).toBe(500);
    deps.getBrainMemory.mockResolvedValue(candidate(deps.createBrainMemoryCandidate.mock.calls[0][0]));
    const response = await submit(loopBody());
    expect(response.status).toBe(200);
    expect((await response.json()).replayed).toBe(true);
    expect(deps.createBrainMemoryCandidate.mock.calls[1][0].id).toBe(deps.createBrainMemoryCandidate.mock.calls[0][0].id);
    warning.mockRestore();
  });
  it("rejects Loop evidence changed between the two reads and rechecks terminal status", async () => {
    const changed = loopPromotionEvents(); changed[0].metadata.contentHash = "e".repeat(64);
    deps.listWorkshopEvents.mockResolvedValueOnce(loopPromotionEvents()).mockResolvedValueOnce(changed);
    const response = await submit(loopBody());
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("source_window_conflict");
    expect(deps.createBrainMemoryCandidate).not.toHaveBeenCalled();
    deps.listWorkshopEvents.mockResolvedValue(loopPromotionEvents());
    deps.readOwnerLoopRun.mockResolvedValueOnce({ run: { status: "success", completedAt: "2026-10-16T00:00:00.000Z" } })
      .mockResolvedValueOnce({ run: { status: "running", completedAt: null } });
    expect((await submit(loopBody())).status).toBe(409);
    expect(deps.createBrainMemoryCandidate).not.toHaveBeenCalled();
  });
  it("replays a Loop command without reopening an already reviewed candidate", async () => {
    deps.listWorkshopEvents.mockResolvedValue(loopPromotionEvents());
    expect((await submit(loopBody())).status).toBe(201);
    const prior = candidate(deps.createBrainMemoryCandidate.mock.calls[0][0]);
    const receipt = deps.appendWorkshopEvent.mock.calls[0][0];
    const events = loopPromotionEvents(); events.push({ ...events[2], id: "77777777-7777-4777-a777-777777777777", seq: 4, ...receipt });
    deps.listWorkshopEvents.mockResolvedValue(events);
    deps.getBrainMemory.mockResolvedValue(prior);
    deps.createBrainMemoryCandidate.mockClear();
    expect((await submit(loopBody())).status).toBe(200);
    expect(deps.createBrainMemoryCandidate).not.toHaveBeenCalled();
    deps.getBrainMemory.mockResolvedValue({ ...prior, status: "verified" });
    const retired = await submit(loopBody());
    expect((await retired.json()).error).toBe("promotion_candidate_retired");
    expect(deps.createBrainMemoryCandidate).not.toHaveBeenCalled();
  });
  it("rejects self-reported claim text and source metadata before opening run history", async () => {
    expect((await submit({ ...body(), content: "forged" })).status).toBe(400);
    expect(deps.listWorkshopEvents).not.toHaveBeenCalled();
    expect(deps.createBrainMemoryCandidate).not.toHaveBeenCalled();
  });
  it("checks the current accepted version again before admission", async () => {
    const changed = promotionEvents(); changed[1].metadata.version = 2;
    deps.listWorkshopEvents.mockResolvedValueOnce(promotionEvents()).mockResolvedValueOnce(changed);
    const response = await submit();
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("working_memory_version_conflict");
    expect(deps.createBrainMemoryCandidate).not.toHaveBeenCalled();
  });
  it("uses stable candidate identity for a retry after the workshop receipt failed", async () => {
    deps.appendWorkshopEvent.mockRejectedValueOnce(Error("store unavailable"));
    const warning = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await submit()).status).toBe(500);
    deps.getBrainMemory.mockResolvedValue(candidate(deps.createBrainMemoryCandidate.mock.calls[0][0]));
    const response = await submit();
    expect(response.status).toBe(200);
    expect((await response.json()).replayed).toBe(true);
    expect(deps.createBrainMemoryCandidate.mock.calls[0][0].id).toBe(deps.createBrainMemoryCandidate.mock.calls[1][0].id);
    warning.mockRestore();
  });
  it("returns a command replay only while its actual candidate remains pending", async () => {
    const initial = await submit(), payload = await initial.json();
    const receipt = deps.appendWorkshopEvent.mock.calls[0][0];
    const events = promotionEvents(); events.push({ ...events[2], id: "77777777-7777-4777-a777-777777777777", seq: 4, ...receipt });
    deps.listWorkshopEvents.mockResolvedValue(events);
    deps.getBrainMemory.mockResolvedValue(candidate(deps.createBrainMemoryCandidate.mock.calls[0][0]));
    deps.createBrainMemoryCandidate.mockClear();
    expect((await submit()).status).toBe(200);
    expect(deps.createBrainMemoryCandidate).not.toHaveBeenCalled();
    deps.getBrainMemory.mockResolvedValue({ id: payload.candidateId, status: "deleted" });
    const retired = await submit();
    expect(retired.status).toBe(409);
    expect((await retired.json()).error).toBe("promotion_candidate_retired");
  });
  it("does not silently submit into an existing candidate with another owner or source identity", async () => {
    await submit();
    const prior = candidate(deps.createBrainMemoryCandidate.mock.calls[0][0]);
    deps.getBrainMemory.mockResolvedValue({ ...prior, ownerId: "other-work" });
    deps.createBrainMemoryCandidate.mockClear();
    const response = await submit();
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("promotion_candidate_identity_conflict");
    expect(deps.createBrainMemoryCandidate).not.toHaveBeenCalled();
  });
  it("compares exact saved source metadata independently of JSON object field order", async () => {
    await submit();
    const prior = candidate(deps.createBrainMemoryCandidate.mock.calls[0][0]);
    const metadata = structuredClone(prior.metadata!);
    const promotion = metadata.workingMemoryPromotion as { sources: Record<string, unknown>[] };
    promotion.sources = promotion.sources.map(source => Object.fromEntries(Object.entries(source).reverse()));
    deps.getBrainMemory.mockResolvedValue({ ...prior, metadata });
    expect((await submit()).status).toBe(200);
    promotion.sources[0].contentHash = "d".repeat(64);
    deps.createBrainMemoryCandidate.mockClear();
    const response = await submit();
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("promotion_candidate_identity_conflict");
    expect(deps.createBrainMemoryCandidate).not.toHaveBeenCalled();
  });
});
