import { createHash } from "node:crypto";
import type { BrainMemory, BrainScope } from "@/lib/memory/kernel/memory-types";

export type BrainObservationSeed = {
  id: string;
  userId: string;
  sourceType: string;
  sourceId: string;
  observedAt: string;
  content: string;
  integrityHash: string;
  metadata: Record<string, unknown>;
};

export type WorkshopMemoryRow = {
  id: string;
  workshopId: string;
  userId: string;
  title?: string | null;
  content: string;
  kind?: string | null;
  sourceRunId?: string | null;
  sourceEventId?: string | null;
  confidence?: number | null;
  createdAt: string;
  updatedAt?: string | null;
};

export type InteractionMemoryRow = {
  id: string;
  userId: string;
  memoryType: string;
  subject: string;
  content: string;
  status: "candidate" | "confirmed" | "dismissed" | string;
  confidence?: number | null;
  sourceEventIds?: string[] | null;
  tags?: string[] | null;
  createdAt: string;
};

export type RawMessageRow = {
  id: string;
  userId: string;
  platform: string;
  conversationId: string;
  messageTime: string;
  content: string;
  metadata?: Record<string, unknown> | null;
};

function clampConfidence(value: number | null | undefined) {
  if (typeof value !== "number" || Number.isNaN(value)) return 50;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function memoryTypeFromLegacy(value: string | null | undefined): BrainMemory["memoryType"] {
  switch (value) {
    case "preference":
    case "plan":
    case "boundary":
    case "relationship":
    case "task":
    case "insight":
    case "system":
      return value;
    default:
      return "fact";
  }
}

export function mapWorkshopMemoryToBrainMemory(
  row: WorkshopMemoryRow,
): BrainMemory {
  return {
    id: `legacy-workshop-memory:${row.id}`,
    userId: row.userId,
    scope: { type: "workshop", workshopId: row.workshopId },
    ownerType: "work",
    ownerId: row.workshopId,
    memoryType: memoryTypeFromLegacy(row.kind),
    subject: row.title?.trim() || "Workshop memory",
    content: row.content,
    status: "active",
    confidence: clampConfidence(row.confidence),
    evidenceRefs: [row.sourceEventId, row.sourceRunId].filter(
      (value): value is string => Boolean(value),
    ),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt ?? row.createdAt,
  };
}

export function mapInteractionMemoryToBrainMemory(
  row: InteractionMemoryRow,
): BrainMemory | null {
  if (row.status === "dismissed") return null;
  return {
    id: `legacy-interaction-memory:${row.id}`,
    userId: row.userId,
    scope: { type: "global" } satisfies BrainScope,
    ownerType: "chat",
    ownerId: row.userId,
    memoryType: memoryTypeFromLegacy(row.memoryType),
    subject: row.subject,
    content: row.content,
    status: row.status === "confirmed" ? "verified" : "candidate",
    confidence: clampConfidence(row.confidence),
    evidenceRefs: row.sourceEventIds ?? [],
    tags: row.tags ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.createdAt,
  };
}

export function mapRawMessageToBrainObservation(
  row: RawMessageRow,
): BrainObservationSeed {
  const sourceId = `${row.platform}:${row.conversationId}:${row.id}`;
  const hash = createHash("sha256")
    .update(
      JSON.stringify({
        sourceId,
        observedAt: row.messageTime,
        content: row.content,
      }),
    )
    .digest("hex");
  return {
    id: `legacy-raw-message:${row.id}`,
    userId: row.userId,
    sourceType: row.platform,
    sourceId,
    observedAt: row.messageTime,
    content: row.content,
    integrityHash: hash,
    metadata: row.metadata ?? {},
  };
}
