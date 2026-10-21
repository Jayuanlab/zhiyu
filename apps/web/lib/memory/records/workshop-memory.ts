import type { Workshop, WorkshopMemory } from "@/lib/db/schema";
import type { WorkshopMemoryKind, WorkshopMemoryStatus } from "@/lib/workshops/types";
import { buildBrainMemoryMetadata, type BrainCanonicalKind } from "../kernel/memory-canonical";
import type { BrainMemory, BrainMemoryStatus, BrainMemoryType, BrainRequester } from "../kernel/memory-types";

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
