import { beforeEach, describe, expect, it, vi } from "vitest";
import { createContinuitySourceVerifier } from "@/lib/memory/continuity/source-validation";
import { verifyExactMemoryRefsForDispatch } from "@/lib/memory/context/exact-use";
import type { HistoricalSource } from "@/lib/memory/continuity/working-memory";
vi.mock("@/lib/memory/context/exact-use", () => ({ verifyExactMemoryRefsForDispatch: vi.fn(async () => undefined) }));
const userId = "11111111-1111-4111-8111-111111111111", workshopId = "22222222-2222-4222-8222-222222222222";
const sourceRunId = "33333333-3333-4333-8333-333333333333", memoryId = "44444444-4444-4444-8444-444444444444";
const loopId = "55555555-5555-4555-8555-555555555555", sourceVersion = "bmrv1:" + "a".repeat(64);
const scope = { userId, workshopId, sourceRunId, loopId: null };
const source: HistoricalSource = { toolCallId: "read-1", sourceEventId: sourceRunId, toolName: "memoryRead",
  contentHash: "b".repeat(64), sourceIdentity: { memoryId, sourceVersion }, provider: null, detail: null, warningCodes: [], warningTexts: [] };
describe("Continuity current source admission", () => {
  beforeEach(() => { vi.mocked(verifyExactMemoryRefsForDispatch).mockReset().mockResolvedValue(undefined); });
  it("checks only explicit stored canonical ID/version within the exact consuming Work", async () => {
    const verify = createContinuitySourceVerifier({ requester: { type: "work", userId, id: workshopId } });
    expect(await verify([source], scope)).toMatchObject([{ status: "current" }]);
    expect(verifyExactMemoryRefsForDispatch).toHaveBeenCalledWith(expect.objectContaining({ refs: [{ id: memoryId, revision: sourceVersion }] }));
  });
  it.each([
    { ...scope, userId: memoryId }, { ...scope, workshopId: memoryId },
  ])("does not borrow a verifier from another scope: %j", async otherScope => {
    const verify = createContinuitySourceVerifier({ requester: { type: "work", userId, id: workshopId } });
    expect(await verify([source], otherScope)).toMatchObject([{ status: "unknown" }]);
    expect(verifyExactMemoryRefsForDispatch).not.toHaveBeenCalled();
  });
  it("requires the declared Loop and Work to match together", async () => {
    const verify = createContinuitySourceVerifier({ requester: { type: "loop", userId, id: loopId, workshopId } });
    expect(await verify([source], { ...scope, loopId: memoryId })).toMatchObject([{ status: "unknown" }]);
    expect(verifyExactMemoryRefsForDispatch).not.toHaveBeenCalled();
    expect(await verify([source], { ...scope, loopId })).toMatchObject([{ status: "current" }]);
  });
  it("does not infer canonical permission from a title, prior hash or a failed proof", async () => {
    const verify = createContinuitySourceVerifier({ requester: { type: "work", userId, id: workshopId } });
    expect(await verify([{ ...source, sourceIdentity: { title: "known", sourceVersion } }], scope)).toMatchObject([{ status: "unknown" }]);
    expect(verifyExactMemoryRefsForDispatch).not.toHaveBeenCalled();
    vi.mocked(verifyExactMemoryRefsForDispatch).mockImplementation(async () => { throw new Error("private permission or receipt failure"); });
    const result = await verify([source], scope);
    expect(result).toMatchObject([{ status: "unknown" }]);
    expect(JSON.stringify(result)).not.toContain("private");
  });
});
