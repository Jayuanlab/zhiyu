import { beforeEach, describe, expect, it, vi } from "vitest";

const reviewTransaction = vi.hoisted(() => vi.fn());
const ordinaryAdmission = vi.hoisted(() => vi.fn());
const evidenceAudit=vi.hoisted(()=>vi.fn(async()=>({recorded:true})));
const retryAudit = vi.hoisted(() => vi.fn(async () => ({ recorded: true })));
const unifiedSearch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/memory/unified-search", () => ({ searchUnifiedMemory: unifiedSearch }));
vi.mock("@/lib/brain/memory-review", () => ({reviewBrainMemoryTransaction: reviewTransaction}));
vi.mock("@/lib/brain/memory-update-admission", () => ({admitOrdinaryBrainMemory: ordinaryAdmission}));

const {
  createBrainAccessGrantMock,
  deleteBrainAccessGrantMock,
  getBrainMemoryByIdMock,
  buildBrainContextPackFromStoreMock,
  resolveBrainEvidenceRefsMock,
  insertBrainMemoryReviewMock,
  insertBrainStateSnapshotMock,
  listBrainAccessGrantsForUserMock,
  listBrainMemoriesForUserMock,
  listBrainObservationsForUserMock,
  listBrainStateSnapshotsMock,
  upsertBrainMemoryMock,
  upsertBrainObservationMock,
} = vi.hoisted(() => ({
  createBrainAccessGrantMock: vi.fn(),
  deleteBrainAccessGrantMock: vi.fn(),
  getBrainMemoryByIdMock: vi.fn(),
  buildBrainContextPackFromStoreMock: vi.fn(),
  resolveBrainEvidenceRefsMock: vi.fn(),
  insertBrainMemoryReviewMock: vi.fn(),
  insertBrainStateSnapshotMock: vi.fn(),
  listBrainAccessGrantsForUserMock: vi.fn(),
  listBrainMemoriesForUserMock: vi.fn(),
  listBrainObservationsForUserMock: vi.fn(),
  listBrainStateSnapshotsMock: vi.fn(),
  upsertBrainMemoryMock: vi.fn(),
  upsertBrainObservationMock: vi.fn(),
}));

vi.mock("@/lib/brain/repository", () => ({
  completeBrainRecallRetryAudit: retryAudit,
  completeBrainEvidenceAudit:evidenceAudit,
  buildBrainContextPackFromStore: buildBrainContextPackFromStoreMock,
  createBrainAccessGrant: createBrainAccessGrantMock,
  deleteBrainAccessGrant: deleteBrainAccessGrantMock,
  getBrainMemoryById: getBrainMemoryByIdMock,
  insertBrainMemoryReview: insertBrainMemoryReviewMock,
  insertBrainStateSnapshot: insertBrainStateSnapshotMock,
  listBrainAccessGrantsForUser: listBrainAccessGrantsForUserMock,
  listBrainMemoriesForUser: listBrainMemoriesForUserMock,
  listBrainObservationsForUser: listBrainObservationsForUserMock,
  listBrainStateSnapshots: listBrainStateSnapshotsMock,
  upsertBrainMemory: upsertBrainMemoryMock,
  upsertBrainObservation: upsertBrainObservationMock,
}));

vi.mock("@/lib/brain/evidence-reader", () => ({
  resolveBrainEvidenceRefs: resolveBrainEvidenceRefsMock,
}));

vi.mock("@/lib/ai/user-llm-api-settings", () => ({
  getUserLlmProviderConfig: vi.fn(async () => null),
}));

import {
  buildBrainContextForRequester,
  buildBrainContextFromMemoryRequest,
  createBrainMemoryCandidate,
  createBrainObservation,
  createBrainStateSnapshot,
  grantBrainAccess,
  listBrainCandidates,
  reviewBrainMemory,
  revokeBrainAccess,
  writeBrainMemory,
} from "@/lib/brain/service";
import type { BrainMemory, BrainRequester } from "@/lib/brain/types";
import * as recallPlanner from "@/lib/brain/recall-planner";

const requester: BrainRequester = {
  type: "chat",
  userId: "user-1",
  id: "chat",
};

function memory(overrides: Partial<BrainMemory> = {}): BrainMemory {
  return {
    id: "memory-1",
    userId: "user-1",
    scope: { type: "global" },
    ownerType: "chat",
    ownerId: "user-1",
    memoryType: "fact",
    subject: "Alpha",
    content: "Alpha memory",
    status: "candidate",
    confidence: 80,
    evidenceRefs: ["event-1"],
    tags: ["alpha"],
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
    ...overrides,
  };
}

describe("brain service", () => {
  it("enforces discovery source restrictions even when the planner enables other routes", async () => {
    const plan = recallPlanner.buildRuleBasedBrainRecallPlan({ requester, taskIntent: "alpha documents" });
    plan.routes = [{ route: "knowledge_store", purpose: "evidence", enabled: true, reason: "planned" }, { route: "memory_graph", purpose: "derived_index", enabled: true, reason: "planned" }];
    const planner = vi.spyOn(recallPlanner, "buildBrainRecallPlan").mockResolvedValueOnce(plan);
    try {
      const result = await buildBrainContextFromMemoryRequest({ requester, taskIntent: "alpha documents", discoverySources: [], allowQueryRetry: false });
      expect(unifiedSearch).not.toHaveBeenCalled();
      expect(result.routeResults).toHaveLength(2);
      expect(result.routeResults.every(route => route.status === "skipped")).toBe(true);
    } finally { planner.mockRestore(); }
  });
  beforeEach(() => {
    ordinaryAdmission.mockReset().mockImplementation(async ({memory}) => memory);
    retryAudit.mockClear();
    unifiedSearch.mockReset();
    createBrainAccessGrantMock.mockReset();
    deleteBrainAccessGrantMock.mockReset();
    getBrainMemoryByIdMock.mockReset();
    buildBrainContextPackFromStoreMock.mockReset();
    resolveBrainEvidenceRefsMock.mockReset();
    insertBrainMemoryReviewMock.mockReset();
    insertBrainStateSnapshotMock.mockReset();
    listBrainAccessGrantsForUserMock.mockReset();
    listBrainMemoriesForUserMock.mockReset();
    listBrainObservationsForUserMock.mockReset();
    listBrainStateSnapshotsMock.mockReset();
    upsertBrainMemoryMock.mockReset();
    upsertBrainObservationMock.mockReset();

    createBrainAccessGrantMock.mockImplementation(async (grant) => ({
      id: "grant-1",
      ...grant,
    }));
    deleteBrainAccessGrantMock.mockResolvedValue({ deletedCount: 1 });
    buildBrainContextPackFromStoreMock.mockResolvedValue({
      interfaceVersion: "brain-context.v1",
      contextLogId: "context-log-1",
      selection: {
        selectedCount: 0,
        deniedCount: 0,
        omittedCount: 0,
        duplicateCanonicalGroupCount: 0,
        selectedCanonicalKinds: {},
      },
      items: [],
      denied: [],
      omitted: [],
      warnings: [],
    });
    resolveBrainEvidenceRefsMock.mockImplementation(
      async ({ evidenceRefs }: { evidenceRefs: string[] }) =>
        evidenceRefs.map((id) => ({
          id,
          status: "unresolved",
          source: "unknown",
          sourceSemantics: "evidence_source",
          ownerHints: [],
          title: null,
          content: null,
          createdAt: null,
          metadata: {},
        })),
    );
    insertBrainMemoryReviewMock.mockResolvedValue({});
    insertBrainStateSnapshotMock.mockImplementation(async (snapshot) => ({
      id: "snapshot-1",
      createdAt: "2026-08-10T00:00:00.000Z",
      ...snapshot,
    }));
    listBrainAccessGrantsForUserMock.mockResolvedValue([]);
    listBrainMemoriesForUserMock.mockResolvedValue([]);
    listBrainObservationsForUserMock.mockResolvedValue([]);
    listBrainStateSnapshotsMock.mockResolvedValue([]);
    upsertBrainMemoryMock.mockImplementation(async (item) => item);
    upsertBrainObservationMock.mockImplementation(async (item) => item);
  });

  it("writes raw observations with a deterministic content hash", async () => {
    await createBrainObservation({
      userId: "user-1",
      sourceType: "interaction_event",
      sourceId: "event-1",
      sourceEventId: "event-1",
      observedAt: "2026-08-10T00:00:00.000Z",
      content: "hello",
      metadata: { platform: "wechat" },
    });

    expect(upsertBrainObservationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        sourceType: "interaction_event",
        sourceId: "event-1",
        sourceEventId: "event-1",
        content: "hello",
        contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
  });

  it("allows candidates without evidence but rejects active memories without evidence", async () => {
    await createBrainMemoryCandidate({
      requester,
      scope: { type: "global" },
      ownerType: "chat",
      ownerId: "user-1",
      memoryType: "fact",
      subject: "Candidate",
      content: "Needs review",
      confidence: 60,
    });

    expect(ordinaryAdmission).toHaveBeenCalledWith(
      expect.objectContaining({memory:expect.objectContaining({
        status: "candidate",
        evidenceRefs: [],
      })}),
    );

    await expect(
      writeBrainMemory({
        requester,
        scope: { type: "global" },
        ownerType: "chat",
        ownerId: "user-1",
        memoryType: "fact",
        subject: "Active",
        content: "Missing evidence",
        status: "active",
      }),
    ).rejects.toThrow("evidence_required");
  });

  it("delegates canonical identity and candidate admission to the atomic controller", async () => {
    const admitted=memory({id:"controller-result",status:"candidate"});
    ordinaryAdmission.mockResolvedValue(admitted);
    const result = await createBrainMemoryCandidate({
      requester,
      scope: { type: "global" },
      ownerType: "chat",
      ownerId: "user-1",
      memoryType: "fact",
      subject: "Duplicate",
      content: "Duplicate memory",
      canonicalGroupId: "semantic:duplicate",
    });

    expect(result).toBe(admitted);
    expect(ordinaryAdmission).toHaveBeenCalledWith(expect.objectContaining({requester,memory:expect.objectContaining({ownerType:"chat",ownerId:"user-1",status:"candidate",metadata:expect.objectContaining({canonicalGroupId:"semantic:duplicate"})})}));
    expect(upsertBrainMemoryMock).not.toHaveBeenCalled();
  });

  it("forces initial model understanding to candidate even when a model requests verified", async () => {
    const result = await writeBrainMemory({
      requester:{...requester,id:"brain-mcp"},
      scope: { type: "global" },
      ownerType: "chat",
      ownerId: "user-1",
      memoryType: "fact",
      subject: "Promoted",
      content: "Promoted memory",
      status: "verified",
      confidence: 80,
      evidenceRefs: ["event-1"],
      canonicalGroupId: "evidence:fact:shared",
    });

    expect(result).toMatchObject({
      status: "candidate",
      confidence: 80,
      content: "Promoted memory",
      metadata:{admission:{requiresOwnerVerification:true,requestedStatus:"verified"}},
    });
    expect(upsertBrainMemoryMock).not.toHaveBeenCalled();
  });

  it("routes review through the atomic review operation", async () => {
    reviewTransaction.mockResolvedValue(memory({status: "verified"}));

    await expect(
      reviewBrainMemory({
        requester,
        memoryId: "memory-1",
        decision: "confirmed",
        reason: "owner approved",
      }),
    ).resolves.toMatchObject({
      id: "memory-1",
      status: "verified",
    });

    expect(reviewTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        requester,
        memoryId: "memory-1",
        decision: "confirmed",
        reason: "owner approved",
      }),
    );
    expect(upsertBrainMemoryMock).not.toHaveBeenCalled();
    expect(insertBrainMemoryReviewMock).not.toHaveBeenCalled();
  });

  it.each(["memory_dependency_registry", "memory_dependency_change"])("rejects forged %s through ordinary snapshot tools", async (snapshotType) => {
    await expect(createBrainStateSnapshot({ userId: "user-1", scope: { type: "global" }, snapshotType,
      content: { sources: ["forged"] }, metadata: { source: "brain-memory-dependencies.v1" } }))
      .rejects.toMatchObject({ code: "reserved_dependency_snapshot", status: 400 });
    expect(insertBrainStateSnapshotMock).not.toHaveBeenCalled();
  });

  it("rejects forged owner correction observations through ordinary observation writes", async () => {
    await expect(createBrainObservation({ userId: "user-1", sourceType: "owner_memory_correction_intent",
      sourceId: "forged-command", observedAt: new Date(), content: "forged owner intent" }))
      .rejects.toMatchObject({ code: "reserved_correction_observation", status: 400 });
    expect(upsertBrainObservationMock).not.toHaveBeenCalled();
  });

  it("rejects forged correction drafts through ordinary snapshot tools", async () => {
    await expect(createBrainStateSnapshot({ userId: "user-1", scope: { type: "global" },
      snapshotType: "memory_correction_draft", content: { intent: "forged owner intent" } }))
      .rejects.toMatchObject({ code: "reserved_correction_snapshot", status: 400 });
    expect(insertBrainStateSnapshotMock).not.toHaveBeenCalled();
  });

  it("builds scoped context and exposes candidates, snapshots and grants", async () => {
    listBrainMemoriesForUserMock.mockResolvedValue([
      memory({ status: "verified" }),
      memory({ id: "candidate-1", status: "candidate" }),
    ]);

    const context = await buildBrainContextForRequester({
      requester,
      taskIntent: "Alpha",
      accessMode: "owner_override",
    });
    expect(context.items.map((item) => item.id)).toEqual(["memory-1"]);

    await listBrainCandidates({ userId: "user-1", limit: 5 });
    expect(listBrainMemoriesForUserMock).toHaveBeenLastCalledWith({
      userId: "user-1",
      statuses: ["candidate"],
      limit: 5,
      ownerType: undefined,
      ownerId: undefined,
    });

    await createBrainStateSnapshot({
      userId: "user-1",
      scope: { type: "global" },
      snapshotType: "owner_context_state",
      content: { candidateCount: 1 },
    });
    expect(insertBrainStateSnapshotMock).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshotType: "owner_context_state",
      }),
    );

    await grantBrainAccess({
      userId: "user-1",
      subjectType: "work",
      subjectId: "work-1",
      scope: { type: "global" },
      permissions: ["reference"],
    });
    expect(createBrainAccessGrantMock).toHaveBeenCalled();

    await revokeBrainAccess({ userId: "user-1", grantId: "grant-1" });
    expect(deleteBrainAccessGrantMock).toHaveBeenCalledWith({
      userId: "user-1",
      grantId: "grant-1",
    });
  });

  it("turns planned evidence_read routes into selected evidence references", async () => {
    resolveBrainEvidenceRefsMock.mockResolvedValue([
      {
        id: "event-1",
        status: "resolved",
        source: "workshop_event",
        sourceSemantics: "evidence_source",
        ownerHints: [{ ownerType: "work", ownerId: "work-1" }],
        title: "Source checked",
        content: "Resolved source event body",
        createdAt: "2026-08-10T00:00:00.000Z",
        metadata: { type: "source_checked" },
      },
      {
        id: "event-2",
        status: "unresolved",
        source: "unknown",
        sourceSemantics: "evidence_source",
        ownerHints: [{ ownerType: "work", ownerId: "work-1" }],
        title: null,
        content: null,
        createdAt: null,
        metadata: {},
      },
    ]);
    buildBrainContextPackFromStoreMock.mockResolvedValue({
      interfaceVersion: "brain-context.v1",
      contextLogId: "context-log-1",
      selection: {
        selectedCount: 1,
        deniedCount: 0,
        omittedCount: 0,
        duplicateCanonicalGroupCount: 0,
        selectedCanonicalKinds: { boundary: 1 },
      },
      items: [
        {
          id: "memory-1",
          ownerType: "work",
          ownerId: "work-1",
          memoryType: "boundary",
          canonicalKind: "boundary",
          subject: "Paper trading boundary",
          content: "High-risk paper-trading actions require evidence.",
          confidence: 90,
          status: "verified",
          scope: { type: "global" },
          tags: [],
          evidenceRefs: ["event-1", "event-2"],
          updatedAt: "2026-08-10T00:00:00.000Z",
        },
      ],
      denied: [],
      omitted: [],
      warnings: [],
    });

    const context = await buildBrainContextFromMemoryRequest({
      requester,
      taskIntent: "Audit high risk paper-trading action before external write",
      platformState: {
        platform: "workshop",
        riskLevel: "high",
        highRiskAction: true,
      },
      action: {
        kind: "external_message",
        description: "Audit high risk paper-trading action before external write",
      },
    });

    const evidenceRead = context.routeResults.find(
      (result) => result.route === "evidence_read",
    );
    expect(context.informationReadiness.version).toBe('information-readiness.v1');
    expect(context.queryRetryTrace.informationReadiness).toEqual(context.informationReadiness);
    expect(retryAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: expect.objectContaining({ informationReadiness: context.informationReadiness }) }));
    expect(evidenceRead).toMatchObject({
      status: "degraded",
      count: 2,
      evidenceQuality:{requested:2,resolved:1,unresolved:1,notChecked:0,memoriesWithoutRefs:0},
    });
    expect(evidenceRead?.results.map((result) => result.id)).toEqual([
      "event-1",
      "event-2",
    ]);
    expect(resolveBrainEvidenceRefsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        evidenceRefs: ["event-1", "event-2"],
        ownerHintsByRef: expect.any(Map),
      }),
    );
    expect(evidenceRead?.results[0]?.content).toBe(
      "Resolved source event body",
    );
    expect(evidenceRead?.results[0]?.metadata).toMatchObject({
      sourceSemantics: "evidence_source",
      expandableWith: "workshopGetMemoryEvidence",
      selectedMemoryIds: ["memory-1"],
      selectedMemoryOwners: [{ ownerType: "work", ownerId: "work-1" }],
      evidenceStatus: "resolved",
      evidenceSource: "workshop_event",
      evidenceTitle: "Source checked",
    });
    expect(context.warnings).toEqual(expect.arrayContaining([expect.objectContaining({code:'evidence_unavailable',memoryIds:['memory-1']})]));
    expect(evidenceAudit).toHaveBeenCalledWith(expect.objectContaining({userId:'user-1',contextLogId:'context-log-1',outcome:expect.objectContaining({status:'degraded'})}));
    resolveBrainEvidenceRefsMock.mockRejectedValueOnce(new Error('private sql payload'));
    const failed=await buildBrainContextFromMemoryRequest({requester,taskIntent:'Audit high risk evidence before external write',platformState:{riskLevel:'high',highRiskAction:true},action:{kind:'external_message'}});
    expect(failed.items).toHaveLength(1);
    expect(failed.routeResults.find(result=>result.route==='evidence_read')).toMatchObject({status:'failed',error:'evidence_reader_unavailable',evidenceQuality:{requested:2,resolved:0,notChecked:2}});
    expect(JSON.stringify(failed)).not.toContain('private sql payload');
    evidenceAudit.mockRejectedValueOnce(new Error('audit unavailable'));
    await expect(buildBrainContextFromMemoryRequest({requester,taskIntent:'Audit high risk evidence',platformState:{riskLevel:'high',highRiskAction:true},action:{kind:'external_message'}})).rejects.toThrow('audit unavailable');
  });

  it("applies rewritten search to routes, keeps original task and restrictions, and records both attempts", async () => {
    const plan = recallPlanner.buildRuleBasedBrainRecallPlan({ requester, taskIntent: "alpha documents" });
    plan.queryRetry = { query: "alpha project documentation", searchTerms: ["documentation"], reason: "Equivalent wording" };
    plan.updatedAfter = "2026-09-01T00:00:00Z";
    const planner = vi.spyOn(recallPlanner, "buildBrainRecallPlan").mockResolvedValueOnce(plan);
    unifiedSearch.mockResolvedValue({ count: 0, results: [] });
    const sourceFilters = { privacyClasses: ["normal"] };
    try {
      const result = await buildBrainContextFromMemoryRequest({ requester, taskIntent: "alpha documents", sourceFilters });
      expect(planner).toHaveBeenCalledTimes(1);
      expect(buildBrainContextPackFromStoreMock).toHaveBeenCalledTimes(2);
      const [first, second] = buildBrainContextPackFromStoreMock.mock.calls.map(call => call[0]);
      expect(second).toMatchObject({ taskIntent: "alpha documents", sourceFilters, updatedAfter: plan.updatedAfter, scopes: first.scopes, statuses: first.statuses, memoryLimit: first.memoryLimit });
      expect(second.searchTerms).toEqual(expect.arrayContaining([...plan.searchTerms, "documentation"]));
      expect(unifiedSearch.mock.calls.map(call => call[0].query)).toEqual(["alpha documents", "alpha project documentation"]);
      expect(result.queryRetryTrace).toMatchObject({ attempts: 2, stopReason: "empty_after_retry" });
      expect(retryAudit).toHaveBeenCalledWith(expect.objectContaining({ userId: requester.userId, outcome: expect.objectContaining({ attempts: 2 }) }));
    } finally { planner.mockRestore(); }
  });

  it("does not retry an empty response caused by an unavailable knowledge source", async () => {
    const plan = recallPlanner.buildRuleBasedBrainRecallPlan({ requester, taskIntent: "alpha documents" });
    plan.queryRetry = { query: "alpha documentation", searchTerms: ["documentation"], reason: "Equivalent wording" };
    const planner = vi.spyOn(recallPlanner, "buildBrainRecallPlan").mockResolvedValueOnce(plan);
    unifiedSearch.mockResolvedValue({ count: 0, results: [], sourceStatuses: [{ source: "knowledge", status: "unavailable" }] });
    try {
      const result = await buildBrainContextFromMemoryRequest({ requester, taskIntent: "alpha documents" });
      expect(unifiedSearch).toHaveBeenCalledTimes(1);
      expect(result.queryRetryTrace.stopReason).toBe("source_unavailable");
      expect(result.routeResults[0]).toMatchObject({ status: "failed", error: "recall_source_incomplete" });
    } finally { planner.mockRestore(); }
  });

  it("honors the global off switch and fails visibly if the final audit cannot persist", async () => {
    const plan = recallPlanner.buildRuleBasedBrainRecallPlan({ requester, taskIntent: "alpha" });
    plan.queryRetry = { query: "alpha delivery", searchTerms: ["delivery"], reason: "Equivalent wording" };
    const planner = vi.spyOn(recallPlanner, "buildBrainRecallPlan").mockResolvedValue(plan);
    vi.stubEnv("BRAIN_RECALL_QUERY_RETRY_ENABLED", "false");
    try {
      const result = await buildBrainContextFromMemoryRequest({ requester, taskIntent: "alpha" });
      expect(result.queryRetryTrace.stopReason).toBe("disabled");
      expect(buildBrainContextPackFromStoreMock).toHaveBeenCalledTimes(1);
      retryAudit.mockRejectedValueOnce(new Error("audit unavailable"));
      await expect(buildBrainContextFromMemoryRequest({ requester, taskIntent: "alpha" })).rejects.toThrow("audit unavailable");
    } finally { planner.mockRestore(); vi.unstubAllEnvs(); }
  });
});
