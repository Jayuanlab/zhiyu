import { beforeEach, describe, expect, it, vi } from "vitest";

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
  beforeEach(() => {
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

    expect(upsertBrainMemoryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "candidate",
        evidenceRefs: [],
      }),
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

  it("reuses an existing canonical memory instead of writing a duplicate", async () => {
    const existing = memory({
      id: "existing-memory",
      status: "candidate",
      metadata: {
        canonicalKind: "fact",
        canonicalGroupId: "semantic:duplicate",
      },
    });
    listBrainMemoriesForUserMock.mockResolvedValue([existing]);

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

    expect(result.id).toBe("existing-memory");
    expect(result.metadata).toMatchObject({
      canonicalAdmission: {
        action: "reused_existing",
        existingMemoryId: "existing-memory",
      },
    });
    expect(upsertBrainMemoryMock).not.toHaveBeenCalled();
  });

  it("promotes an existing canonical candidate instead of creating another row", async () => {
    const existing = memory({
      id: "existing-candidate",
      status: "candidate",
      confidence: 40,
      metadata: {
        canonicalKind: "fact",
        canonicalGroupId: "evidence:fact:shared",
      },
    });
    listBrainMemoriesForUserMock.mockResolvedValue([existing]);

    const result = await writeBrainMemory({
      requester,
      scope: { type: "global" },
      ownerType: "chat",
      ownerId: "user-1",
      memoryType: "fact",
      subject: "Promoted",
      content: "Promoted memory",
      status: "active",
      confidence: 80,
      evidenceRefs: ["event-1"],
      canonicalGroupId: "evidence:fact:shared",
    });

    expect(result).toMatchObject({
      id: "existing-candidate",
      status: "active",
      confidence: 80,
      content: "Promoted memory",
    });
    expect(upsertBrainMemoryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "existing-candidate",
        status: "active",
        metadata: expect.objectContaining({
          canonicalAdmission: expect.objectContaining({
            action: "merged_existing",
            existingMemoryId: "existing-candidate",
          }),
        }),
      }),
    );
  });

  it("reviews memories by changing status and appending a review record", async () => {
    getBrainMemoryByIdMock.mockResolvedValue(memory());

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

    expect(upsertBrainMemoryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "memory-1",
        status: "verified",
      }),
    );
    expect(insertBrainMemoryReviewMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        memoryId: "memory-1",
        reviewerType: "chat",
        reviewerId: "chat",
        decision: "confirmed",
        reason: "owner approved",
        evidenceRefs: ["event-1"],
      }),
    );
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
    expect(evidenceRead).toMatchObject({
      status: "executed",
      count: 2,
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
  });
});
