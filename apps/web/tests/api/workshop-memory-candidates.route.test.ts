import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const state = vi.hoisted(() => ({ userId: "owner-1" as string | null, enabled: true }));
const getWorkshop = vi.hoisted(() => vi.fn());
const listWorkshopEvents = vi.hoisted(() => vi.fn());
const appendWorkshopEvent = vi.hoisted(() => vi.fn());
const proposeMemoryPolicyCandidates = vi.hoisted(() => vi.fn());
const repository = vi.hoisted(() => ({ getEvidence: vi.fn(), getResolvedSnapshot: vi.fn(), getLatestSnapshot: vi.fn() }));

vi.mock("@/app/(auth)/auth", () => ({ auth: async () => state.userId ? { user: { id: state.userId } } : null }));
vi.mock("@/lib/workshops/service", () => ({ getWorkshop, listWorkshopEvents, appendWorkshopEvent }));
vi.mock("@/lib/harness-evolution", () => ({ harnessEvolutionRepository: repository, isWorkHarnessEvolutionEnabled: () => state.enabled, proposeMemoryPolicyCandidates }));

const context = { params: Promise.resolve({ id: "work-1" }) };
const request = (body: unknown) => ({ json: async () => body } as NextRequest);
const validBody = { evidenceBundleId: "evidence-1", evaluationSuiteId: "suite-1", developmentScenarioIds: ["development-1"] };

describe("owner memory candidate API", () => {
  beforeEach(() => {
    vi.clearAllMocks(); state.userId = "owner-1"; state.enabled = true;
    getWorkshop.mockResolvedValue({ id: "work-1", userId: "owner-1" });
    repository.getEvidence.mockResolvedValue({ bundle: { id: "evidence-1", workId: "work-1", userId: "owner-1", workRunId: "run-1", loopRunId: null, captureStatus: "finalized", harnessSnapshotId: "snapshot-1" } });
    const baseline = { id: "snapshot-1", componentSetHash: "set-1", workVersionId: "version-1" };
    repository.getResolvedSnapshot.mockResolvedValue(baseline); repository.getLatestSnapshot.mockResolvedValue(baseline);
    listWorkshopEvents.mockResolvedValue([{ id: "event-1", type: "working_memory_updated", metadata: { receiptAuthority: "runtime" }, createdAt: new Date("2026-10-13T00:00:00Z") }]);
    proposeMemoryPolicyCandidates.mockResolvedValue({ diagnosis: { status: "completed" }, proposals: [{ id: "proposal-1", status: "proposed" }] });
  });

  it("checks authentication and work ownership before reading trajectory evidence", async () => {
    const { POST } = await import("@/app/api/workshops/[id]/harness/memory-candidates/route");
    state.userId = null;
    expect((await POST(request(validBody), context)).status).toBe(401);
    state.userId = "owner-1"; getWorkshop.mockResolvedValue(null);
    expect((await POST(request(validBody), context)).status).toBe(404);
    expect(repository.getEvidence).not.toHaveBeenCalled();
  });

  it("rejects payloads that inject prompts, authority, policy patches or hidden optimizer inputs", async () => {
    const { POST } = await import("@/app/api/workshops/[id]/harness/memory-candidates/route");
    expect((await POST(request({ ...validBody, principal: { kind: "owner", userId: "victim" }, patch: { denied: [] } }), context)).status).toBe(400);
    expect(proposeMemoryPolicyCandidates).not.toHaveBeenCalled();
  });

  it("returns pending candidates and audits that evaluation and configuration activation were not triggered", async () => {
    const { POST } = await import("@/app/api/workshops/[id]/harness/memory-candidates/route");
    const response = await POST(request(validBody), context);
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ applied: false, modelEvaluationTriggered: false, proposals: [{ status: "proposed" }] });
    expect(listWorkshopEvents).toHaveBeenCalledWith("work-1", expect.objectContaining({ runId: "run-1", limit: 501 }));
    expect(appendWorkshopEvent).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ applied: false, modelEvaluationTriggered: false }) }));
  });

  it("keeps unknown, foreign and stale evidence out of candidate generation", async () => {
    const { POST } = await import("@/app/api/workshops/[id]/harness/memory-candidates/route");
    repository.getEvidence.mockResolvedValue({ bundle: { workId: "work-1", userId: "different-owner" } });
    expect((await POST(request(validBody), context)).status).toBe(404);
    repository.getEvidence.mockResolvedValue({ bundle: { id: "evidence-1", workId: "work-1", userId: "owner-1", workRunId: "run-1", captureStatus: "finalized", harnessSnapshotId: "snapshot-1" } });
    repository.getLatestSnapshot.mockResolvedValue({ componentSetHash: "newer-set", workVersionId: "version-1" });
    expect((await POST(request(validBody), context)).status).toBe(409);
    expect(proposeMemoryPolicyCandidates).not.toHaveBeenCalled();
  });

  it("does not hide evidence truncation or a disabled capture pipeline", async () => {
    const { POST } = await import("@/app/api/workshops/[id]/harness/memory-candidates/route");
    state.enabled = false;
    expect((await POST(request(validBody), context)).status).toBe(409);
    state.enabled = true; listWorkshopEvents.mockResolvedValue(Array.from({ length: 501 }, (_, index) => ({ id: String(index) })));
    expect((await POST(request(validBody), context)).status).toBe(409);
    expect(proposeMemoryPolicyCandidates).not.toHaveBeenCalled();
  });
});
