import { describe, expect, it } from "vitest";
import {
  brainAccessGrantFromRow,
  brainMemoryFromRow,
  brainContextLogToInsertRow,
  brainMemoryToInsertRow,
  brainMemoryReviewToInsertRow,
} from "@/lib/brain/repository";
import type { BrainMemory, BrainRequester } from "@/lib/brain/types";

describe("brain repository row mapping", () => {
  it("maps physical memory rows back into domain memories", () => {
    const memory = brainMemoryFromRow({
      id: "memory-1",
      userId: "user-1",
      scopeType: "workshop",
      scopeId: "workshop-1",
      ownerType: "work",
      ownerId: "workshop-1",
      memoryType: "plan",
      subject: "Plan",
      content: "Use current watchlist only.",
      status: "active",
      confidence: 80,
      evidenceRefs: ["event-1"],
      tags: ["watchlist"],
      metadata: {},
      expiresAt: null,
      supersedes: [],
      createdAt: new Date("2026-08-10T00:00:00.000Z"),
      updatedAt: new Date("2026-08-10T01:00:00.000Z"),
    } as any);

    expect(memory).toMatchObject({
      id: "memory-1",
      scope: { type: "workshop", workshopId: "workshop-1" },
      ownerType: "work",
      memoryType: "plan",
      evidenceRefs: ["event-1"],
      tags: ["watchlist"],
    });
  });

  it("maps physical grant rows into domain access grants", () => {
    const grant = brainAccessGrantFromRow({
      id: "grant-1",
      userId: "user-1",
      subjectType: "work",
      subjectId: "workshop-1",
      scopeType: "workshop",
      scopeId: "watchlist-workshop",
      permissions: ["reference"],
      memoryTypes: ["plan"],
      reason: "share watchlist plan",
      expiresAt: null,
      createdAt: new Date("2026-08-10T00:00:00.000Z"),
      updatedAt: new Date("2026-08-10T00:00:00.000Z"),
    } as any);

    expect(grant).toMatchObject({
      id: "grant-1",
      subjectType: "work",
      subjectId: "workshop-1",
      scope: { type: "workshop", workshopId: "watchlist-workshop" },
      permissions: ["reference"],
      memoryTypes: ["plan"],
    });
  });

  it("maps brain memory into the physical table shape", () => {
    const memory: BrainMemory = {
      id: "memory-1",
      userId: "user-1",
      scope: { type: "workshop", workshopId: "workshop-1" },
      ownerType: "work",
      ownerId: "workshop-1",
      memoryType: "boundary",
      subject: "Risk boundary",
      content: "Never place real broker orders.",
      status: "verified",
      confidence: 95,
      evidenceRefs: ["event-1"],
      tags: ["risk"],
      createdAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-10T01:00:00.000Z",
    };

    expect(brainMemoryToInsertRow(memory)).toMatchObject({
      id: "memory-1",
      userId: "user-1",
      scopeType: "workshop",
      scopeId: "workshop-1",
      ownerType: "work",
      ownerId: "workshop-1",
      memoryType: "boundary",
      status: "verified",
      evidenceRefs: ["event-1"],
      tags: ["risk"],
    });
  });

  it("maps context packs into auditable context logs", () => {
    const requester: BrainRequester = {
      type: "work",
      userId: "user-1",
      id: "workshop-1",
      workshopId: "workshop-1",
    };

    const row = brainContextLogToInsertRow({
      requester,
      taskIntent: "pre market plan",
      pack: {
        interfaceVersion: "brain-context.v1",
        selection: {
          selectedCount: 1,
          deniedCount: 1,
          omittedCount: 1,
          duplicateCanonicalGroupCount: 0,
          selectedCanonicalKinds: {},
        },
        items: [
          {
            id: "memory-1",
            revisionVersion: `bmrv1:${"a".repeat(64)}`,
            ownerType: "work",
            ownerId: "workshop-1",
            memoryType: "plan",
            subject: "Plan",
            content: "Follow the plan.",
            evidenceRefs: ["event-1"],
            score: 90,
            reasons: ["type:plan"],
          },
        ],
        denied: [{ id: "memory-2", reason: "no_matching_grant" }],
        omitted: [{ id: "memory-3", reason: "candidate_requires_review" }],
      },
      metadata: { source: "unit-test", selectedMemoryVersions: [{ memoryId: "forged", revisionVersion: "forged" }] },
    });

    expect(row).toMatchObject({
      userId: "user-1",
      requesterType: "work",
      requesterId: "workshop-1",
      taskIntent: "pre market plan",
      selectedMemoryIds: ["memory-1"],
      denied: [{ id: "memory-2", reason: "no_matching_grant" }],
      omitted: [{ id: "memory-3", reason: "candidate_requires_review" }],
      metadata: { source: "unit-test", selectedMemoryVersions: [{ memoryId: "memory-1", revisionVersion: `bmrv1:${"a".repeat(64)}` }] },
    });
  });

  it("maps memory review decisions into the physical table shape", () => {
    const row = brainMemoryReviewToInsertRow({
      userId: "user-1",
      memoryId: "memory-1",
      reviewerType: "chat",
      reviewerId: "user-1",
      decision: "confirmed",
      evidenceRefs: ["event-1"],
      metadata: {
        source: "owner_context_review",
        legacyKind: "memory",
      },
    });

    expect(row).toMatchObject({
      userId: "user-1",
      memoryId: "memory-1",
      reviewerType: "chat",
      reviewerId: "user-1",
      decision: "confirmed",
      evidenceRefs: ["event-1"],
      metadata: {
        source: "owner_context_review",
        legacyKind: "memory",
      },
    });
  });
});
