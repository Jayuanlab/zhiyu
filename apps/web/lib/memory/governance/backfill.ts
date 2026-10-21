import { mapInteractionMemoryToBrainMemory } from "@/lib/memory/records/legacy-adapters";
import { workshopMemoryToBrainMemory } from "@/lib/memory/records/workshop-memory";
import type { BrainMemory } from "@/lib/memory/kernel/memory-types";

export type BrainBackfillReport = {
  scanned: number;
  memories: number;
  observations: number;
  skipped: number;
  missingEvidence: number;
  conflicts: number;
  errors: Array<{ id: string; message: string }>;
};

export function emptyBrainBackfillReport(): BrainBackfillReport {
  return {
    scanned: 0,
    memories: 0,
    observations: 0,
    skipped: 0,
    missingEvidence: 0,
    conflicts: 0,
    errors: [],
  };
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === "string")
        : [];
    } catch {
      return [];
    }
  }
  return [];
}

function dateString(value: unknown) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.trim()) return value;
  return new Date().toISOString();
}

export function interactionMemoryRowToBrainBackfill(row: any) {
  const memory = mapInteractionMemoryToBrainMemory({
    id: String(row.id),
    userId: String(row.userId),
    memoryType: String(row.memoryType ?? "fact"),
    subject: String(row.subject ?? "Interaction memory"),
    content: String(row.content ?? ""),
    status: String(row.status ?? "candidate"),
    confidence:
      typeof row.confidence === "number" ? row.confidence : Number(row.confidence ?? 50),
    sourceEventIds: stringArray(row.sourceEventIds),
    tags: stringArray(row.tags),
    createdAt: dateString(row.createdAt),
  });
  return memory ? { ...memory, id: String(row.id) } : null;
}

export function workshopMemoryRowToBrainBackfill(input: {
  workshop: { id: string; userId: string };
  memory: any;
}): BrainMemory {
  return workshopMemoryToBrainMemory({
    workshop: input.workshop,
    memory: {
      id: String(input.memory.id),
      workshopId: input.workshop.id,
      userId: input.workshop.userId,
      kind: String(input.memory.kind ?? "finding"),
      content: String(input.memory.content ?? ""),
      confidence:
        typeof input.memory.confidence === "number"
          ? input.memory.confidence
          : Number(input.memory.confidence ?? 50),
      tags: stringArray(input.memory.tags),
      sourceEventIds: stringArray(input.memory.sourceEventIds),
      expiresAt: input.memory.expiresAt ?? null,
      createdAt: dateString(input.memory.createdAt),
      updatedAt: dateString(input.memory.updatedAt ?? input.memory.createdAt),
      status: input.memory.status,
    } as any,
  });
}

export function trackBackfilledMemory(
  report: BrainBackfillReport,
  memory: BrainMemory | null,
) {
  report.scanned += 1;
  if (!memory) {
    report.skipped += 1;
    return;
  }
  if (memory.evidenceRefs.length === 0) {
    report.missingEvidence += 1;
  }
  report.memories += 1;
}
