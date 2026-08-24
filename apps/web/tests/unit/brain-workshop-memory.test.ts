import { describe, expect, it } from "vitest";
import type { Workshop, WorkshopMemory } from "@/lib/db/schema";
import {
  brainContextPackToWorkshopMemoryContextPack,
  buildWorkshopBrainContextPack,
  validateWorkshopMemoryWrite,
  workshopMemoryToBrainMemory,
} from "@/lib/brain/workshop-memory";

function workshop(): Pick<Workshop, "id" | "userId"> {
  return { id: "workshop-1", userId: "user-1" };
}

function memory(overrides: Partial<WorkshopMemory> = {}): WorkshopMemory {
  return {
    id: "memory-1",
    workshopId: "workshop-1",
    kind: "boundary",
    content: "Never place real broker orders.",
    confidence: 90,
    tags: ["risk"],
    sourceEventIds: ["event-1"],
    expiresAt: null,
    createdAt: new Date("2026-08-10T00:00:00.000Z"),
    updatedAt: new Date("2026-08-10T00:00:00.000Z"),
    ...overrides,
  } as WorkshopMemory;
}

describe("brain workshop memory adapter", () => {
  it("maps workshop memories into work-owned scoped brain memories", () => {
    expect(
      workshopMemoryToBrainMemory({
        workshop: workshop(),
        memory: memory({ status: "verified" } as Partial<WorkshopMemory>),
      }),
    ).toMatchObject({
      id: "memory-1",
      userId: "user-1",
      scope: { type: "workshop", workshopId: "workshop-1" },
      ownerType: "work",
      ownerId: "workshop-1",
      memoryType: "boundary",
      status: "verified",
      evidenceRefs: ["event-1"],
    });
  });

  it("rejects usable active memory without evidence", () => {
    const check = validateWorkshopMemoryWrite({
      workshop: workshop(),
      memory: {
        workshopId: "workshop-1",
        kind: "finding",
        content: "A durable finding.",
        confidence: 80,
        status: "active",
      },
      sourceEventIds: [],
    });

    expect(check.issues.map((issue) => issue.code)).toContain(
      "evidence_required",
    );
  });

  it("allows candidate memory without evidence so it can wait for review", () => {
    const check = validateWorkshopMemoryWrite({
      workshop: workshop(),
      memory: {
        workshopId: "workshop-1",
        kind: "hypothesis",
        content: "A weak hypothesis to review later.",
        confidence: 45,
        status: "candidate",
      },
      sourceEventIds: [],
    });

    expect(check.issues).toEqual([]);
  });

  it("builds context packs through the shared brain policy", () => {
    const pack = buildWorkshopBrainContextPack({
      workshop: workshop(),
      taskIntent: "paper trading risk boundary",
      memories: [
        memory({ id: "boundary", kind: "boundary" }),
        memory({
          id: "candidate",
          kind: "finding",
          status: "candidate",
        } as Partial<WorkshopMemory>),
      ],
      now: new Date("2026-08-10T01:00:00.000Z"),
    });

    expect(pack.items.map((item) => item.id)).toEqual(["boundary"]);
    expect(pack.omitted).toEqual([
      { id: "candidate", reason: "candidate_requires_review" },
    ]);
  });

  it("converts brain context packs into the legacy workshop prompt shape", () => {
    const pack = brainContextPackToWorkshopMemoryContextPack({
      taskIntent: "paper trading risk",
      pack: {
        interfaceVersion: "brain-context.v1",
        selection: {
          selectedCount: 2,
          deniedCount: 1,
          omittedCount: 1,
          duplicateCanonicalGroupCount: 0,
          selectedCanonicalKinds: {},
        },
        items: [
          {
            id: "brain-boundary",
            ownerType: "work",
            ownerId: "workshop-1",
            memoryType: "boundary",
            subject: "Risk boundary",
            content: "Never place real broker orders.",
            evidenceRefs: ["event-1"],
            score: 120,
            reasons: ["type:boundary"],
          },
          {
            id: "brain-plan",
            ownerType: "work",
            ownerId: "workshop-1",
            memoryType: "plan",
            subject: "Trading plan",
            content: "Use current watchlist only.",
            evidenceRefs: ["event-2"],
            score: 80,
            reasons: ["type:plan"],
          },
        ],
        denied: [{ id: "denied", reason: "no_matching_grant" }],
        omitted: [{ id: "candidate", reason: "candidate_requires_review" }],
        warnings: [
          {
            code: "potential_state_conflict",
            memoryIds: ["brain-plan"],
            message: "Verify the current state before acting.",
            requiresCurrentObservation: true,
          },
        ],
      },
    });

    expect(pack.controlModel).toBe("engineering_cybernetics_v1");
    expect(pack.taskRelevantMemories.map((item) => item.id)).toEqual([
      "brain-boundary",
      "brain-plan",
    ]);
    expect(pack.riskBoundaries.map((item) => item.id)).toEqual([
      "brain-boundary",
    ]);
    expect(pack.evidenceRefs).toEqual(["event-1", "event-2"]);
    expect(pack.omittedReason).toContain("omitted=1");
    expect(pack.openQuestions).toContain(
      "Verify the current state before acting.",
    );
    expect(pack.taskRelevantMemories[1]?.reasons).toEqual(
      expect.arrayContaining(["brain_context", "type:plan"]),
    );
  });
});
