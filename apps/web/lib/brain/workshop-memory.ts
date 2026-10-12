import type { Workshop, WorkshopMemory } from "@/lib/db/schema";
import type {
  WorkshopMemoryContextItem,
  WorkshopMemoryContextPack,
} from "@/lib/workshops/memory-context";
import type {
  AddWorkshopMemoryInput,
  WorkshopMemoryKind,
  WorkshopMemoryStatus,
} from "@/lib/workshops/types";
import { buildBrainContextPack } from "./context";
import {
  buildBrainMemoryMetadata,
  type BrainCanonicalKind,
} from "./canonical";
import type { BrainRecallProfile } from "./context";
import { validateMemoryWrite } from "./policy";
import type {
  BrainAccessGrant,
  BrainMemory,
  BrainMemoryStatus,
  BrainMemoryType,
  BrainRequester,
  BrainValidationIssue,
  BrainWriteRequest,
} from "./types";

export type WorkshopBrainWriteCheck = {
  request: BrainWriteRequest;
  issues: BrainValidationIssue[];
};

export function workshopMemoryKindToBrainType(
  kind: WorkshopMemoryKind | string,
): BrainMemoryType {
  switch (kind) {
    case "preference":
      return "preference";
    case "boundary":
    case "mistake":
      return "boundary";
    case "watchlist":
      return "plan";
    case "hypothesis":
    case "finding":
    case "source_note":
    case "outbox_summary":
    default:
      return "fact";
  }
}

export function workshopMemoryStatusToBrainStatus(
  status: WorkshopMemoryStatus | string | undefined,
): BrainMemoryStatus {
  switch (status) {
    case "candidate":
      return "candidate";
    case "verified":
    case "confirmed":
      return "verified";
    case "weakened":
      return "weakened";
    case "dismissed":
      return "deleted";
    case "active":
    default:
      return "active";
  }
}

function workshopMemoryKindToCanonicalKind(
  kind: WorkshopMemoryKind | string,
): BrainCanonicalKind {
  switch (kind) {
    case "boundary":
      return "boundary";
    case "preference":
      return "preference";
    case "watchlist":
      return "plan";
    case "mistake":
      return "lesson";
    case "finding":
    case "source_note":
    case "hypothesis":
    case "outbox_summary":
    default:
      return "fact";
  }
}

export function createWorkshopBrainRequester(
  workshop: Pick<Workshop, "id" | "userId">,
): BrainRequester {
  return {
    type: "work",
    userId: workshop.userId,
    id: workshop.id,
    workshopId: workshop.id,
  };
}

export function workshopMemoryToBrainMemory(input: {
  workshop: Pick<Workshop, "id" | "userId">;
  memory: WorkshopMemory & { status?: string };
}): BrainMemory {
  const { workshop, memory } = input;
  const tags = Array.isArray(memory.tags)
    ? memory.tags.filter((tag): tag is string => typeof tag === "string")
    : [];
  const sourceEventIds = Array.isArray(memory.sourceEventIds)
    ? memory.sourceEventIds.filter((id): id is string => typeof id === "string")
    : [];
  const status = workshopMemoryStatusToBrainStatus(memory.status);
  const memoryType = workshopMemoryKindToBrainType(memory.kind);

  return {
    id: memory.id,
    userId: workshop.userId,
    scope: { type: "workshop", workshopId: workshop.id },
    ownerType: "work",
    ownerId: workshop.id,
    memoryType,
    subject: memory.kind,
    content: memory.content,
    status,
    confidence: Number.isFinite(memory.confidence) ? memory.confidence : 50,
    evidenceRefs: sourceEventIds,
    tags,
    createdAt:
      memory.createdAt instanceof Date
        ? memory.createdAt.toISOString()
        : String(memory.createdAt),
    updatedAt:
      memory.updatedAt instanceof Date
        ? memory.updatedAt.toISOString()
        : String(memory.updatedAt),
    expiresAt:
      memory.expiresAt instanceof Date
        ? memory.expiresAt.toISOString()
        : memory.expiresAt
          ? String(memory.expiresAt)
          : undefined,
    metadata: buildBrainMemoryMetadata({
      memoryType,
      subject: memory.kind,
      content: memory.content,
      scope: { type: "workshop", workshopId: workshop.id },
      ownerType: "work",
      ownerId: workshop.id,
      evidenceRefs: sourceEventIds,
      tags,
      canonicalKind: workshopMemoryKindToCanonicalKind(memory.kind),
      facets: {
        sourceKind: "workshop_memory",
        domain: "workshop",
        workshopId: workshop.id,
        workshopKind: memory.kind,
      },
      derivedRefs: [
        {
          source: "workshop_memory",
          id: memory.id,
          relation: "mirrors",
        },
      ],
    }),
  };
}

export function validateWorkshopMemoryWrite(input: {
  workshop: Pick<Workshop, "id" | "userId">;
  memory: AddWorkshopMemoryInput;
  sourceEventIds: string[];
  grants?: BrainAccessGrant[];
  now?: Date;
}): WorkshopBrainWriteCheck {
  const status = workshopMemoryStatusToBrainStatus(
    input.memory.status ?? "active",
  );
  const request: BrainWriteRequest = {
    requester: createWorkshopBrainRequester(input.workshop),
    targetScope: { type: "workshop", workshopId: input.workshop.id },
    ownerType: "work",
    ownerId: input.workshop.id,
    memoryType: workshopMemoryKindToBrainType(input.memory.kind),
    status,
    confidence: input.memory.confidence ?? 50,
    evidenceRefs: input.sourceEventIds,
  };
  return {
    request,
    issues: validateMemoryWrite({
      request,
      grants: input.grants,
      now: input.now,
    }),
  };
}

export function buildWorkshopBrainContextPack(input: {
  workshop: Pick<Workshop, "id" | "userId">;
  memories: Array<WorkshopMemory & { status?: string }>;
  taskIntent: string;
  grants?: BrainAccessGrant[];
  now?: Date;
  maxItems?: number;
  recallProfiles?: BrainRecallProfile[];
}) {
  const requester = createWorkshopBrainRequester(input.workshop);
  return buildBrainContextPack({
    memories: input.memories.map((memory) =>
      workshopMemoryToBrainMemory({ workshop: input.workshop, memory }),
    ),
    requester,
    taskIntent: input.taskIntent,
    grants: input.grants,
    now: input.now,
    maxItems: input.maxItems,
    recallProfiles: input.recallProfiles,
  });
}

function workshopKindFromBrainType(type: BrainMemoryType): WorkshopMemoryKind {
  switch (type) {
    case "boundary":
      return "boundary";
    case "preference":
      return "preference";
    case "plan":
      return "watchlist";
    case "insight":
      return "finding";
    default:
      return "finding";
  }
}

function workshopStatusFromBrainStatus(status: BrainMemoryStatus): string {
  switch (status) {
    case "verified":
      return "verified";
    case "weakened":
      return "weakened";
    case "candidate":
      return "candidate";
    case "deleted":
    case "superseded":
      return "dismissed";
    default:
      return "active";
  }
}

function brainItemToWorkshopItem(
  item: ReturnType<typeof buildBrainContextPack>["items"][number],
): WorkshopMemoryContextItem {
  return {
    id: item.id,
    revisionVersion: item.revisionVersion,
    kind: workshopKindFromBrainType(item.memoryType),
    status: "active",
    content: item.content,
    confidence: Math.max(0, Math.min(100, Math.round(item.score))),
    tags: ["brain"],
    sourceEventIds: item.evidenceRefs,
    score: Math.round(item.score),
    reasons: [
      "brain_context",
      ...item.reasons,
      ...(item.warnings ?? []).map((warning) => `warning:${warning}`),
    ],
  };
}

export function brainContextPackToWorkshopMemoryContextPack(input: {
  taskIntent: string;
  pack: ReturnType<typeof buildBrainContextPack>;
}): WorkshopMemoryContextPack {
  const items = input.pack.items.map(brainItemToWorkshopItem);
  const coreState = items.filter(
    (item) => item.kind === "boundary" || item.kind === "preference",
  );
  const riskBoundaries = items.filter((item) => item.kind === "boundary");
  const evidenceRefs = [
    ...new Set(items.flatMap((item) => item.sourceEventIds)),
  ];

  return {
    controlModel: "engineering_cybernetics_v1",
    taskIntent: input.taskIntent,
    informationReadiness: input.pack.informationReadiness,
    coreState,
    taskRelevantMemories: items,
    recentLessons: [],
    riskBoundaries,
    evidenceRefs,
    openQuestions: [
      ...(items.length > 0
        ? []
        : ["No active Brain memory was recalled for this run."]),
      ...(input.pack.warnings ?? []).map((warning) => warning.message),
    ],
    omittedReason:
      input.pack.omitted.length > 0 || input.pack.denied.length > 0
        ? `Brain context omitted=${input.pack.omitted.length}, denied=${input.pack.denied.length}.`
        : null,
    stats: {
      totalMemories:
        input.pack.items.length +
        input.pack.omitted.length +
        input.pack.denied.length,
      activeMemories: input.pack.items.length,
      candidateMemories: input.pack.omitted.filter(
        (item) => item.reason === "candidate_requires_review",
      ).length,
      verifiedMemories: 0,
      weakenedMemories: 0,
      dismissedMemories: input.pack.omitted.filter(
        (item) => item.reason === "deleted",
      ).length,
      expiredMemories: input.pack.omitted.filter(
        (item) => item.reason === "expired",
      ).length,
      selectedMemories: input.pack.items.length,
    },
  };
}
