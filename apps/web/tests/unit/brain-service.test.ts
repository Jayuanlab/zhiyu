import { beforeEach, describe, expect, it, vi } from "vitest";

const reviewTransaction = vi.hoisted(() => vi.fn());
const ordinaryAdmission = vi.hoisted(() => vi.fn());
const evidenceAudit=vi.hoisted(()=>vi.fn(async()=>({recorded:true})));
const retryAudit = vi.hoisted(() => vi.fn(async () => ({ recorded: true })));
const unifiedSearch = vi.hoisted(() => vi.fn());
const contextStore = vi.hoisted(() => ({ memories: [] as import("@/lib/memory/kernel/memory-types").BrainMemory[] }));
const finalLogWrite = vi.hoisted(() => vi.fn());
vi.mock("@/lib/memory/revision/transaction", () => ({
  withMemoryRecordWrite: async (_userId: string, _kind: string, run: (store: object) => Promise<{ result: unknown }>) => (await run({})).result,
}));
vi.mock("@/lib/memory/adapters/postgres/context-logs", () => ({
  lockContextOwnerForShare: vi.fn(async () => {}),
  insertContextLogInTransaction: finalLogWrite,
}));
vi.mock("@/lib/memory/unified-search", () => ({ searchUnifiedMemory: unifiedSearch }));
vi.mock("@/lib/memory/revision/review", () => ({reviewBrainMemoryTransaction: reviewTransaction}));
vi.mock("@/lib/memory/revision/admission", () => ({admitOrdinaryBrainMemory: ordinaryAdmission}));

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

vi.mock("@/lib/memory/adapters/postgres/observations", () => ({
  upsertObservation: upsertBrainObservationMock, listObservationsForUser: listBrainObservationsForUserMock,
}));
vi.mock("@/lib/memory/governance/access-grants", () => ({
  createBrainAccessGrant: createBrainAccessGrantMock,
  deleteBrainAccessGrant: deleteBrainAccessGrantMock,
}));
vi.mock("@/lib/memory/adapters/postgres/state-snapshots", () => ({
  insertStateSnapshotInTransaction: async (_store: unknown, input: unknown) => insertBrainStateSnapshotMock(input),
  listBrainStateSnapshots: listBrainStateSnapshotsMock,
  catalogBrainStateSnapshots: vi.fn(async () => ({ types: [], hasMoreTypes: false })),
}));
vi.mock("@/lib/memory/adapters/postgres/memory-records", () => ({
  listAccessGrantsForUser: listBrainAccessGrantsForUserMock,
  listBrainAccessGrantsForUser: listBrainAccessGrantsForUserMock,
  getBrainMemoryById: getBrainMemoryByIdMock,
  readContextMemoriesForShare: vi.fn(async () => contextStore.memories),
  readContextGrantsForShare: listBrainAccessGrantsForUserMock,
  readContextPendingUpdates: vi.fn(async () => []),
}));

vi.mock("@/lib/memory/retrieval/candidates", () => ({ listBrainMemoriesForUser: listBrainMemoriesForUserMock }));
vi.mock("@/lib/memory/context/from-store", () => ({ buildBrainContextPackFromStore: buildBrainContextPackFromStoreMock }));
vi.mock("@/lib/memory/context/audit", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/memory/context/audit")>(),
  completeBrainEvidenceAudit: evidenceAudit, completeBrainRecallRetryAudit: retryAudit,
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

vi.mock("@/lib/memory/evidence/reader", () => ({
  resolveEvidenceRefs: resolveBrainEvidenceRefsMock,
}));

vi.mock("@/lib/ai/user-llm-api-settings", () => ({
  getUserLlmProviderConfig: vi.fn(async () => null),
}));

import {
  attachSelectedEvidenceReadResults,
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
import * as recallPlanner from "@/lib/memory/retrieval/recall-planner";
import { buildBrainContextPack } from "@/lib/memory/context/pack";
import * as evidenceChecker from "@/lib/memory/retrieval/jev-evidence-check";

const requester: BrainRequester = {
  type: "chat",
  userId: "00000000-0000-4000-8000-000000000001",
  id: "chat",
};

function memory(overrides: Partial<BrainMemory> = {}): BrainMemory {
  return {
    id: "00000000-0000-4000-8000-000000000002",
    userId: "00000000-0000-4000-8000-000000000001",
    scope: { type: "global" },
    ownerType: "chat",
    ownerId: "00000000-0000-4000-8000-000000000001",
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
  it("keeps resolved reference counts while exposing same-root source groups", async () => {
    const refs = ["observation", "event", "raw-message:42", "legacy-raw-message:message-42"];
    resolveBrainEvidenceRefsMock.mockResolvedValue(refs.map((id, index) => ({ id, status: "resolved", source: index === 0 ? "brain_observation" : index === 1 ? "interaction_event" : "raw_message",
      sourceSemantics: "evidence_source", ownerHints: [], title: null, content: "fixture evidence", createdAt: null, metadata: {},
      resolvedIdentity: index === 0 ? { source: "brain_observation", sourceId: "observation-row", sourceEventId: "event-row" }
        : index === 1 ? { source: "interaction_event", sourceId: "event-row" } : { source: "raw_message", sourceId: "42" } })));
    const result = await attachSelectedEvidenceReadResults({ request: { requester, taskIntent: "read selected evidence" },
      routeResults: [{ route: "evidence_read", purpose: "evidence", status: "planned", reason: "read", count: 0, results: [] }],
      pack: { interfaceVersion: "brain-context.v1", items: [{ ...memory({ evidenceRefs: refs }), canonicalKind: "fact" }],
        denied: [], omitted: [] } as any });
    expect(result[0]).toMatchObject({ status: "executed", count: 4, evidenceQuality: { resolved: 4, resolvedRootGroups: 2, overlappingResolvedRefs: 2,
      lineageSemantics: "resolved_source_groups_not_independent_evidence" } });
    const groups = new Map(result[0].results.map(item => [item.id, item.metadata.evidenceRootGroup]));
    expect(groups.get("observation")).toEqual(groups.get("event"));
    expect(groups.get("raw-message:42")).toEqual(groups.get("legacy-raw-message:message-42"));
  });
  it("persists only the reported planner provider terminal identity for a new context log", async () => {
    const request = { requester, taskIntent: "Inspect the current source", discoverySources: [] as Array<'knowledge' | 'graph'>, allowQueryRetry: false };
    const provider = { source: "user_anthropic_compatible" as const, model: "qwen3.7-plus", protocol: "anthropic-messages" as const,
      baseUrl: "https://example.test/private?credential=excluded", configuredBaseUrl: "https://private.test/old-route", migrated: true,
      thinkingMode: "disabled" as const, finishReason: "end_turn", apiKey: "credential-sentinel", body: "private-response-sentinel" };
    const plan: recallPlanner.BrainRecallPlan = { ...recallPlanner.buildRuleBasedBrainRecallPlan(request), mode: "llm", provider, warnings: ["Current sources still need verification."] };
    plan.routes = [{ route: "brain_memory", enabled: true, purpose: "canonical", reason: "Canonical store" }];
    const planner = vi.spyOn(recallPlanner, "buildBrainRecallPlan").mockResolvedValueOnce(plan);
    try {
      const result = await buildBrainContextFromMemoryRequest(request);
      const audit = buildBrainContextPackFromStoreMock.mock.calls[0][0].metadata.recallPlanner;
      expect(audit).toMatchObject({ mode: "llm", warnings: plan.warnings, provider: { source: provider.source, model: provider.model,
        protocol: provider.protocol, finishReason: "end_turn", thinkingMode: "disabled", migrated: true } });
      expect(Object.keys(audit.provider).sort()).toEqual(["source", "model", "protocol", "finishReason", "thinkingMode", "migrated"].sort());
      expect(JSON.stringify(audit.provider)).not.toMatch(/credential|private-response|private\.test|example\.test/);
      expect(result.recallPlan.provider).toBe(provider);
    } finally { planner.mockRestore(); }
  });
  it("keeps fallback mode and warnings while missing provider terminal fields stay null", async () => {
    const request = { requester, taskIntent: "Inspect source availability", discoverySources: [] as Array<'knowledge' | 'graph'>, allowQueryRetry: false };
    const plan = recallPlanner.buildRuleBasedBrainRecallPlan(request, "llm_recall_planner_failed:timeout");
    plan.provider = { source: "env_anthropic_compatible", model: "same-model", protocol: "anthropic-messages", migrated: false };
    plan.routes = [{ route: "brain_memory", enabled: true, purpose: "canonical", reason: "Canonical store" }];
    const planner = vi.spyOn(recallPlanner, "buildBrainRecallPlan").mockResolvedValueOnce(plan);
    try {
      const result = await buildBrainContextFromMemoryRequest(request);
      expect(buildBrainContextPackFromStoreMock.mock.calls[0][0].metadata.recallPlanner).toMatchObject({ mode: "fallback_rules", warnings: ["llm_recall_planner_failed:timeout"],
        provider: { source: "env_anthropic_compatible", model: "same-model", protocol: "anthropic-messages", migrated: false, finishReason: null, thinkingMode: null } });
      expect(result.recallPlan.mode).toBe("fallback_rules");
      expect(result.recallPlan.provider?.finishReason).toBeUndefined();
    } finally { planner.mockRestore(); }
  });
  it("records absent planner provider as null without inventing a completed terminal", async () => {
    const request = { requester, taskIntent: "Inspect without a configured provider", discoverySources: [] as Array<'knowledge' | 'graph'>, allowQueryRetry: false };
    const plan = recallPlanner.buildRuleBasedBrainRecallPlan(request);
    plan.routes = [{ route: "brain_memory", enabled: true, purpose: "canonical", reason: "Canonical store" }];
    const planner = vi.spyOn(recallPlanner, "buildBrainRecallPlan").mockResolvedValueOnce(plan);
    try {
      await buildBrainContextFromMemoryRequest(request);
      expect(buildBrainContextPackFromStoreMock.mock.calls[0][0].metadata.recallPlanner).toMatchObject({ mode: "rules", warnings: [], provider: null });
    } finally { planner.mockRestore(); }
  });
  it.each([
    ['normal', false, 'execute', true], ['low', false, 'answer', true], ['high', false, 'execute', false],
    ['normal', true, 'execute', false], ['normal', false, 'trade', false], ['normal', false, 'external_message', false],
    ['normal', false, 'config_change', false], ['normal', false, 'write_memory', false], [undefined, false, 'answer', false],
  ] as const)('gates owner correction feedback by actual caller risk/action without lowering confidence: %s/%s/%s', async (riskLevel, highRiskAction, kind, enabled) => {
    const request = { requester, taskIntent: 'Research source conditions', platformState: { riskLevel, highRiskAction },
      action: { kind }, discoverySources: [] as Array<'knowledge' | 'graph'>, allowQueryRetry: false };
    const plan = recallPlanner.buildRuleBasedBrainRecallPlan(request);
    plan.minConfidence = 70;
    plan.routes = [{ route: 'brain_memory', enabled: true, purpose: 'canonical', reason: 'Canonical store' }];
    const planner = vi.spyOn(recallPlanner, 'buildBrainRecallPlan').mockResolvedValueOnce(plan);
    try {
      await buildBrainContextFromMemoryRequest(request);
      expect(buildBrainContextPackFromStoreMock).toHaveBeenCalledWith(expect.objectContaining({ reserveCurrentOwnerCorrections: enabled, minConfidence: 70 }));
    } finally { planner.mockRestore(); }
  });
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
  it.each(['work', 'loop', 'tool'] as const)('blocks owner-wide auxiliary indexes for a %s requester even when requested by the planner', async (type) => {
    const scopedRequester: BrainRequester = { ...requester, type, id: 'scoped-requester', workId: 'work-a' };
    const request = { requester: scopedRequester, taskIntent: 'alpha documents',
      discoverySources: ['knowledge', 'graph'] as Array<'knowledge' | 'graph'>, allowQueryRetry: false };
    const plan = recallPlanner.buildRuleBasedBrainRecallPlan(request);
    plan.routes = [
      { route: 'knowledge_store', purpose: 'evidence', enabled: true, reason: 'planned' },
      { route: 'memory_graph', purpose: 'derived_index', enabled: true, reason: 'planned' },
      { route: 'evidence_read', purpose: 'evidence', enabled: true, reason: 'selected refs' },
    ];
    const planner = vi.spyOn(recallPlanner, 'buildBrainRecallPlan').mockResolvedValueOnce(plan);
    try {
      const result = await buildBrainContextFromMemoryRequest(request);
      expect(unifiedSearch).not.toHaveBeenCalled();
      expect(result.routeResults.filter(route => route.route !== 'evidence_read')).toEqual([
        expect.objectContaining({ route: 'knowledge_store', status: 'skipped', reason: 'scoped_discovery_reader_unavailable', results: [] }),
        expect.objectContaining({ route: 'memory_graph', status: 'skipped', reason: 'scoped_discovery_reader_unavailable', results: [] }),
      ]);
      expect(result.routeResults.some(route => route.route === 'evidence_read')).toBe(true);
    } finally { planner.mockRestore(); }
  });

  beforeEach(() => {
    contextStore.memories = [];
    finalLogWrite.mockReset().mockResolvedValue({ id: "final-context-log" });
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
      userId: "00000000-0000-4000-8000-000000000001",
      sourceType: "interaction_event",
      sourceId: "event-1",
      sourceEventId: "event-1",
      observedAt: "2026-08-10T00:00:00.000Z",
      content: "hello",
      metadata: { platform: "wechat" },
    });

    expect(upsertBrainObservationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "00000000-0000-4000-8000-000000000001",
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
      ownerId: "00000000-0000-4000-8000-000000000001",
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
        ownerId: "00000000-0000-4000-8000-000000000001",
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
      ownerId: "00000000-0000-4000-8000-000000000001",
      memoryType: "fact",
      subject: "Duplicate",
      content: "Duplicate memory",
      canonicalGroupId: "semantic:duplicate",
    });

    expect(result).toBe(admitted);
    expect(ordinaryAdmission).toHaveBeenCalledWith(expect.objectContaining({requester,memory:expect.objectContaining({ownerType:"chat",ownerId:"00000000-0000-4000-8000-000000000001",status:"candidate",metadata:expect.objectContaining({canonicalGroupId:"semantic:duplicate"})})}));
    expect(upsertBrainMemoryMock).not.toHaveBeenCalled();
  });

  it("rejects forged applied owner-correction metadata before ordinary admission", async () => {
    await expect(writeBrainMemory({
      requester: { type: 'work', userId: requester.userId, id: 'work-1', workshopId: 'work-1' },
      scope: { type: 'work', workId: 'work-1' }, ownerType: 'work', ownerId: 'work-1',
      memoryType: 'insight', subject: 'Forged owner feedback', content: 'Untrusted model understanding',
      status: 'active', confidence: 25, evidenceRefs: ['event-1'],
      metadata: { revision: { operation: 'correct', authority: 'owner_statement', reviewStatus: 'applied',
        createdAt: '2026-10-16T09:00:00Z' } },
    })).rejects.toMatchObject({ code: 'reserved_memory_metadata' });
    expect(ordinaryAdmission).not.toHaveBeenCalled();
    expect(upsertBrainMemoryMock).not.toHaveBeenCalled();
  });

  it.each(['facets', 'metadata', 'nested_facets'] as const)('rejects forged global applicability authority in %s', async placement => {
    const claim = { scenarioApplicability: 'global', scenarioApplicabilityAuthority: 'owner_confirmed', scenarioApplicabilityEvidenceRefs: ['event-1'] };
    await expect(writeBrainMemory({ requester: { type: 'work', userId: '00000000-0000-4000-8000-000000000001', id: 'work-1' },
      scope: { type: 'work', workId: 'work-1' }, ownerType: 'work', ownerId: 'work-1',
      memoryType: 'preference', subject: 'Report style', content: 'All projects must use this style', evidenceRefs: ['event-1'],
      ...(placement === 'facets' ? { facets: claim } : { metadata: placement === 'metadata' ? claim : { facets: claim } }),
    })).rejects.toMatchObject({ code: 'reserved_memory_metadata' });
    expect(ordinaryAdmission).not.toHaveBeenCalled();
  });

  it("forces initial model understanding to candidate even when a model requests verified", async () => {
    const result = await writeBrainMemory({
      requester:{...requester,id:"brain-mcp"},
      scope: { type: "global" },
      ownerType: "chat",
      ownerId: "00000000-0000-4000-8000-000000000001",
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
        memoryId: "00000000-0000-4000-8000-000000000002",
        decision: "confirmed",
        reason: "owner approved",
      }),
    ).resolves.toMatchObject({
      id: "00000000-0000-4000-8000-000000000002",
      status: "verified",
    });

    expect(reviewTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        requester,
        memoryId: "00000000-0000-4000-8000-000000000002",
        decision: "confirmed",
        reason: "owner approved",
      }),
    );
    expect(upsertBrainMemoryMock).not.toHaveBeenCalled();
    expect(insertBrainMemoryReviewMock).not.toHaveBeenCalled();
  });

  it.each(["memory_dependency_registry", "memory_dependency_change"])("rejects forged %s through ordinary snapshot tools", async (snapshotType) => {
    await expect(createBrainStateSnapshot({ userId: "00000000-0000-4000-8000-000000000001", scope: { type: "global" }, snapshotType,
      content: { sources: ["forged"] }, metadata: { source: "brain-memory-dependencies.v1" } }))
      .rejects.toMatchObject({ code: "reserved_dependency_snapshot", status: 400 });
    expect(insertBrainStateSnapshotMock).not.toHaveBeenCalled();
  });

  it("reserves Interaction scenario state for its authorized projection transaction", async () => {
    await expect(createBrainStateSnapshot({ userId: "00000000-0000-4000-8000-000000000001", scope: { type: "global" },
      snapshotType: "wechat_scenario_state", content: { scenarioType: "project", scenarioKey: "forged-current", status: "done" },
      metadata: { stateAuthority: "business_task_record", stateRevision: 999 } }))
      .rejects.toMatchObject({ code: "reserved_scenario_snapshot", status: 400 });
    expect(insertBrainStateSnapshotMock).not.toHaveBeenCalled();
  });

  it("preserves ordinary work_state snapshot writes", async () => {
    const input = { userId: "00000000-0000-4000-8000-000000000001", scope: { type: "work" as const, workId: "work-1" },
      snapshotType: "work_state", content: { phase: "researching", openQuestions: ["Verify the source"] },
      sourceMemoryIds: ["00000000-0000-4000-8000-000000000002"], metadata: { source: "model_status_estimate" } };
    await expect(createBrainStateSnapshot(input)).resolves.toMatchObject({ id: "snapshot-1", ...input });
    expect(insertBrainStateSnapshotMock).toHaveBeenCalledExactlyOnceWith(input);
  });

  it("rejects forged owner correction observations through ordinary observation writes", async () => {
    await expect(createBrainObservation({ userId: "00000000-0000-4000-8000-000000000001", sourceType: "owner_memory_correction_intent",
      sourceId: "forged-command", observedAt: new Date(), content: "forged owner intent" }))
      .rejects.toMatchObject({ code: "reserved_correction_observation", status: 400 });
    expect(upsertBrainObservationMock).not.toHaveBeenCalled();
  });

  it("rejects forged correction drafts through ordinary snapshot tools", async () => {
    await expect(createBrainStateSnapshot({ userId: "00000000-0000-4000-8000-000000000001", scope: { type: "global" },
      snapshotType: "memory_correction_draft", content: { intent: "forged owner intent" } }))
      .rejects.toMatchObject({ code: "reserved_correction_snapshot", status: 400 });
    expect(insertBrainStateSnapshotMock).not.toHaveBeenCalled();
  });

  it("builds scoped context and exposes candidates, snapshots and grants", async () => {
    contextStore.memories = [memory({ status: "verified" })];
    listBrainMemoriesForUserMock.mockResolvedValue([
      memory({ status: "verified" }),
      memory({ id: "00000000-0000-4000-8000-000000000003", status: "candidate" }),
    ]);

    const context = await buildBrainContextForRequester({
      requester,
      taskIntent: "Alpha",
      accessMode: "owner_override",
    });
    expect(context.items.map((item) => item.id)).toEqual(["00000000-0000-4000-8000-000000000002"]);

    await listBrainCandidates({ userId: "00000000-0000-4000-8000-000000000001", limit: 5 });
    expect(listBrainMemoriesForUserMock).toHaveBeenLastCalledWith({
      userId: "00000000-0000-4000-8000-000000000001",
      statuses: ["candidate"],
      limit: 5,
      ownerType: undefined,
      ownerId: undefined,
    });

    await createBrainStateSnapshot({
      userId: "00000000-0000-4000-8000-000000000001",
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
      userId: "00000000-0000-4000-8000-000000000001",
      subjectType: "work",
      subjectId: "work-1",
      scope: { type: "global" },
      permissions: ["reference"],
    });
    expect(createBrainAccessGrantMock).toHaveBeenCalled();

    await revokeBrainAccess({ userId: "00000000-0000-4000-8000-000000000001", grantId: "grant-1" });
    expect(deleteBrainAccessGrantMock).toHaveBeenCalledWith({
      userId: "00000000-0000-4000-8000-000000000001",
      grantId: "grant-1",
    });
  });

  it.each(["removed", "version_changed", "grant_revoked"])("withholds selected bodies and route evidence after final admission detects %s", async change => {
    const current = memory({ status: "verified", subject: "Authorized source", content: "old-memory-body-sentinel" });
    const grant = { id: "grant", userId: requester.userId, subjectType: "chat" as const, subjectId: requester.id,
      scope: { type: "global" as const }, permissions: ["read" as const] };
    contextStore.memories = [current];
    listBrainAccessGrantsForUserMock.mockResolvedValue([grant]);
    buildBrainContextPackFromStoreMock.mockResolvedValue({ ...buildBrainContextPack({ requester, memories: [current], grants: [grant],
      taskIntent: "Audit source evidence" }), contextLogId: "attempt-log" });
    resolveBrainEvidenceRefsMock.mockImplementationOnce(async () => {
      if (change === "removed") contextStore.memories = [];
      if (change === "version_changed") contextStore.memories = [{ ...current, content: "new-source-content" }];
      if (change === "grant_revoked") listBrainAccessGrantsForUserMock.mockResolvedValue([]);
      return [{ id: "event-1", status: "resolved", source: "interaction_event", content: "old-evidence-body-sentinel",
        title: "old-evidence-title-sentinel", metadata: { private: "old-evidence-metadata-sentinel" } }];
    });
    const checker = vi.spyOn(evidenceChecker, "checkRecallEvidence").mockResolvedValueOnce({ provider: "typesafe", mode: "off", status: "disabled", elapsedMs: 0 });
    let result: Awaited<ReturnType<typeof buildBrainContextFromMemoryRequest>>;
    try {
      result = await buildBrainContextFromMemoryRequest({ requester, taskIntent: "Audit source evidence", allowQueryRetry: false,
        platformState: { riskLevel: "high" }, action: { kind: "review" } });
      expect(checker).toHaveBeenCalledOnce();
      expect(checker.mock.calls[0][0].evidence).toEqual([]);
      expect(JSON.stringify(checker.mock.calls[0][0])).not.toMatch(/old-memory-body|old-evidence-body|old-evidence-title|old-evidence-metadata/);
    } finally { checker.mockRestore(); }
    expect(result.items).toEqual([]);
    expect(result.contextLogId).toBe("final-context-log");
    expect(result.routeResults.find(route => route.route === "evidence_read")).toMatchObject({ count: 0, results: [] });
    expect(JSON.stringify(result)).not.toMatch(/old-memory-body|old-evidence-body|old-evidence-title|old-evidence-metadata/);
    expect(retryAudit).toHaveBeenCalledWith(expect.objectContaining({ contextLogId: "final-context-log",
      outcome: expect.objectContaining({ contextLogIds: ["attempt-log"] }) }));
    expect(finalLogWrite).toHaveBeenCalledTimes(2);
    expect(finalLogWrite.mock.calls[0][1].metadata).toMatchObject({ phase: "evidence_check_admission" });
  });

  it("keeps trusted rules planning local and explicitly disables independent model judging", async () => {
    const planner = vi.spyOn(recallPlanner, "buildBrainRecallPlan").mockRejectedValue(new Error("Configured provider must not be called"));
    const checker = vi.spyOn(evidenceChecker, "checkRecallEvidence").mockRejectedValue(new Error("Auxiliary judge must not be called"));
    try {
      const result = await buildBrainContextFromMemoryRequest({ requester, taskIntent: "Audit source evidence", allowQueryRetry: false,
        planningMode: "rules", discoverySources: [], action: { kind: "answer" } });
      expect(result.recallPlan.mode).toBe("rules");
      expect(result.queryRetryTrace.evidenceCheck).toMatchObject({ mode: "off", status: "disabled",
        detail: "local_deterministic_rules_no_independent_verification" });
      expect(planner).not.toHaveBeenCalled(); expect(checker).not.toHaveBeenCalled(); expect(unifiedSearch).not.toHaveBeenCalled();
      expect(finalLogWrite).toHaveBeenCalledOnce();
    } finally { planner.mockRestore(); checker.mockRestore(); }
  });

  it("does not reuse a shared-ref body read using an owner removed by final admission", async () => {
    const retained = memory({ status: "verified", subject: "Retained source", content: "retained authorized fact",
      metadata: { canonicalKind: "fact", canonicalGroupId: "retained-group" } });
    const removed = memory({ id: "00000000-0000-4000-8000-000000000004", status: "verified", subject: "Removed source", content: "removed-memory-sentinel",
      metadata: { canonicalKind: "fact", canonicalGroupId: "removed-group" } });
    const pack = buildBrainContextPack({ requester, memories: [retained, removed], accessMode: "owner_override", taskIntent: "Audit source evidence" });
    expect(pack.items).toHaveLength(2);
    contextStore.memories = [retained];
    buildBrainContextPackFromStoreMock.mockResolvedValue({ ...pack, contextLogId: "attempt-log" });
    resolveBrainEvidenceRefsMock.mockResolvedValueOnce([{ id: "event-1", status: "resolved", source: "workshop_event",
      content: "removed-owner-read-sentinel", title: "removed-owner-title-sentinel", metadata: { private: "removed-owner-meta-sentinel" } }]);
    const result = await buildBrainContextFromMemoryRequest({ requester, taskIntent: "Audit source evidence", allowQueryRetry: false,
      accessMode: "owner_override", platformState: { riskLevel: "high" }, action: { kind: "review" } });
    expect(result.items.map(item => item.id)).toEqual([retained.id]);
    const evidence = result.routeResults.find(route => route.route === "evidence_read")!;
    expect(evidence).toMatchObject({ status: "degraded", results: [{ id: "event-1", metadata: {
      evidenceStatus: "not_checked", selectedMemoryIds: [retained.id], reason: "evidence_authorization_changed" } }] });
    expect(JSON.stringify(result)).not.toMatch(/removed-memory-sentinel|removed-owner-/);
  });

  it("fails instead of returning the earlier pack when final admission audit cannot persist", async () => {
    finalLogWrite.mockResolvedValueOnce({ id: "evidence-check-admission" }).mockRejectedValueOnce(new Error("private SQL and provider configuration"));
    await expect(buildBrainContextFromMemoryRequest({ requester, taskIntent: "source facts", allowQueryRetry: false }))
      .rejects.toMatchObject({ code: "memory_context_unavailable", status: 503 });
    expect(retryAudit).not.toHaveBeenCalled();
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
    const boundary = memory({ ownerType: "work", ownerId: "work-1", memoryType: "boundary",
      subject: "Paper trading boundary", content: "High-risk paper-trading actions require evidence.",
      confidence: 90, status: "verified", evidenceRefs: ["event-1", "event-2"] });
    contextStore.memories = [boundary];
    buildBrainContextPackFromStoreMock.mockResolvedValue({
      ...buildBrainContextPack({ memories: [boundary], requester, accessMode: "owner_override", taskIntent: "Audit high risk paper-trading action before external write" }),
      contextLogId: "context-log-1",
    });

    const context = await buildBrainContextFromMemoryRequest({
      requester,
      taskIntent: "Audit high risk paper-trading action before external write",
      accessMode: "owner_override",
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
        userId: "00000000-0000-4000-8000-000000000001",
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
      selectedMemoryIds: ["00000000-0000-4000-8000-000000000002"],
      selectedMemoryOwners: [{ ownerType: "work", ownerId: "work-1" }],
      evidenceStatus: "resolved",
      evidenceSource: "workshop_event",
      evidenceTitle: "Source checked",
    });
    expect(context.warnings).toEqual(expect.arrayContaining([expect.objectContaining({code:'evidence_unavailable',memoryIds:['00000000-0000-4000-8000-000000000002']})]));
    expect(evidenceAudit).toHaveBeenCalledWith(expect.objectContaining({userId:'00000000-0000-4000-8000-000000000001',contextLogId:'context-log-1',outcome:expect.objectContaining({status:'degraded'})}));
    resolveBrainEvidenceRefsMock.mockRejectedValueOnce(new Error('private sql payload'));
    const failed=await buildBrainContextFromMemoryRequest({requester,accessMode:'owner_override',taskIntent:'Audit high risk evidence before external write',platformState:{riskLevel:'high',highRiskAction:true},action:{kind:'external_message'}});
    expect(failed.items).toHaveLength(1);
    expect(failed.routeResults.find(result=>result.route==='evidence_read')).toMatchObject({status:'failed',error:'evidence_reader_unavailable',evidenceQuality:{requested:2,resolved:0,notChecked:2}});
    expect(JSON.stringify(failed)).not.toContain('private sql payload');
    evidenceAudit.mockRejectedValueOnce(new Error('audit unavailable'));
    await expect(buildBrainContextFromMemoryRequest({requester,accessMode:'owner_override',taskIntent:'Audit high risk evidence',platformState:{riskLevel:'high',highRiskAction:true},action:{kind:'external_message'}})).rejects.toMatchObject({ code: 'memory_recall_attempt_unavailable', status: 503 });
  });

  it("does not return a prior successful snapshot when a retry attempt cannot persist its audit", async () => {
    const plan = recallPlanner.buildRuleBasedBrainRecallPlan({ requester, taskIntent: "alpha" });
    plan.queryRetry = { query: "alpha source alias", searchTerms: ["source-alias"], reason: "Equivalent source wording" };
    const planner = vi.spyOn(recallPlanner, "buildBrainRecallPlan").mockResolvedValueOnce(plan);
    buildBrainContextPackFromStoreMock.mockResolvedValueOnce({ ...buildBrainContextPack({ memories: [], requester, taskIntent: "alpha" }),
      contextLogId: "first-attempt" }).mockRejectedValueOnce(new Error("private SQL audit insertion failed"));
    try {
      await expect(buildBrainContextFromMemoryRequest({ requester, taskIntent: "alpha" }))
        .rejects.toMatchObject({ code: "memory_recall_attempt_unavailable", status: 503 });
      expect(buildBrainContextPackFromStoreMock).toHaveBeenCalledTimes(2);
      expect(retryAudit).not.toHaveBeenCalled();
    } finally { planner.mockRestore(); }
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
