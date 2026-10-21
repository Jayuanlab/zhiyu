import {
  buildOwnerContextSnapshotFromLegacy,
  listOwnerContextCandidatesFromLegacy,
  ownerContextItemFromInteractionMemory,
} from "@/lib/memory/context/owner-context";
import { insertBrainMemoryReview, upsertBrainMemory } from "@/lib/memory/revision/legacy-storage";
import { mapInteractionMemoryToBrainMemory } from "@/lib/memory/records/legacy-adapters";
import type { BrainMemory } from "@/lib/memory/kernel/memory-types";
import {
  clearInteractionGraph,
  listInteractionGraphSnapshot,
} from "@/lib/interactions/graph";
import { processInteractionEvents } from "@/lib/interactions/processor";
import {
  clearInteractionWikiItems,
  getInteractionEventsByIds,
  listInteractionEvents,
  listInteractionWiki,
  updateInteractionMemoryStatus,
  updateInteractionTaskStatus,
} from "@/lib/interactions/service";
import type { InteractionProcessingMode } from "@/lib/knowledge-pipeline/source-policy-runtime";
import type {
  OwnerContextCandidateDecision,
  OwnerContextCandidateKind,
  OwnerContextCandidateListResult,
  OwnerContextCandidateReviewResult,
  OwnerContextItem,
  OwnerContextRequest,
  OwnerContextSnapshot,
  OwnerKnowledgeDashboard,
  OwnerKnowledgeResetResult,
} from "./types";

const DEFAULT_LIMIT = 120;
const MAX_LIMIT = 1_000;
const OWNER_CONTEXT_INTERFACE_VERSION = "owner-context.v1" as const;

function clampLimit(value: unknown) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(number), 1), MAX_LIMIT);
}

function isoDate(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item)).filter(Boolean)
    : [];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function candidateDecisionToBrainStatus(
  decision: OwnerContextCandidateDecision,
): BrainMemory["status"] {
  return decision === "confirmed" ? "verified" : "deleted";
}

async function writeBrainReview(input: {
  userId: string;
  memory: BrainMemory;
  decision: OwnerContextCandidateDecision;
  legacyKind: OwnerContextCandidateKind;
  legacyId: string;
}) {
  try {
    await upsertBrainMemory(input.memory);
    await insertBrainMemoryReview({
      userId: input.userId,
      memoryId: input.memory.id,
      reviewerType: "chat",
      reviewerId: input.userId,
      decision: input.decision,
      evidenceRefs: input.memory.evidenceRefs,
      metadata: {
        source: "owner_context_review",
        legacyKind: input.legacyKind,
        legacyId: input.legacyId,
      },
    });
  } catch (error) {
    console.warn("[OwnerContext] Brain review write failed", {
      userId: input.userId,
      memoryId: input.memory.id,
      legacyKind: input.legacyKind,
      legacyId: input.legacyId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function toTaskItem(task: any): OwnerContextItem {
  const status = String(task.status ?? "candidate");
  return {
    id: String(task.id),
    kind: "task",
    title: String(task.title ?? "Task"),
    body: String(task.description ?? ""),
    state:
      status === "confirmed" || status === "done"
        ? "confirmed"
        : status === "dismissed" || status === "archived" || status === "deleted"
          ? "dismissed"
          : "candidate",
    source: "interaction_wiki",
    confidence: typeof task.confidence === "number" ? task.confidence : null,
    sourceEventIds: stringArray(task.sourceEventIds),
    metadata: {
      ...record(task.metadata),
      status: task.status,
      dueAt: isoDate(task.dueAt),
      assigneeName: task.assigneeName ?? null,
      requesterName: task.requesterName ?? null,
    },
    createdAt: isoDate(task.createdAt),
    updatedAt: isoDate(task.updatedAt ?? task.createdAt),
  };
}

function taskToReviewedBrainMemory(input: {
  userId: string;
  task: any;
  decision: OwnerContextCandidateDecision;
}): BrainMemory {
  const createdAt =
    isoDate(input.task.createdAt) ?? new Date().toISOString();
  return {
    id: `legacy-interaction-task:${String(input.task.id)}`,
    userId: input.userId,
    scope: { type: "global" },
    ownerType: "chat",
    ownerId: input.userId,
    memoryType: "task",
    subject: String(input.task.title ?? "Task"),
    content: String(input.task.description ?? ""),
    status: candidateDecisionToBrainStatus(input.decision),
    confidence:
      typeof input.task.confidence === "number"
        ? Math.max(0, Math.min(100, Math.round(input.task.confidence)))
        : 50,
    evidenceRefs: stringArray(input.task.sourceEventIds),
    tags: ["owner-context", "task"],
    createdAt,
    updatedAt: isoDate(input.task.updatedAt ?? input.task.createdAt) ?? createdAt,
  };
}

function interactionMemoryToReviewedBrainMemory(input: {
  userId: string;
  memory: any;
  decision: OwnerContextCandidateDecision;
}): BrainMemory | null {
  const mapped = mapInteractionMemoryToBrainMemory({
    ...input.memory,
    userId: input.userId,
    status: input.decision === "confirmed" ? "confirmed" : "candidate",
    createdAt:
      isoDate(input.memory.createdAt) ?? new Date().toISOString(),
  });
  return mapped
    ? {
        ...mapped,
        status: candidateDecisionToBrainStatus(input.decision),
        updatedAt:
          isoDate(input.memory.updatedAt ?? input.memory.createdAt) ??
          mapped.updatedAt,
      }
    : null;
}

export async function getOwnerContext(
  input: OwnerContextRequest,
): Promise<OwnerContextSnapshot> {
  const limit = clampLimit(input.maxItems);

  const [wiki, events, graphSnapshot] = await Promise.all([
    listInteractionWiki({ userId: input.userId, limit }),
    listInteractionEvents({
      userId: input.userId,
      conversationId: input.conversationId,
      limit,
    }),
    listInteractionGraphSnapshot({
      userId: input.userId,
      entityLimit: Math.min(limit * 2, 500),
      relationLimit: Math.min(limit * 2, 500),
    }),
  ]);

  return buildOwnerContextSnapshotFromLegacy({
    userId: input.userId,
    scene: input.scene,
    query: input.query,
    wiki,
    events: events ?? [],
    graphSnapshot,
  });
}

export async function listOwnerKnowledge(input: {
  userId: string;
  limit?: number;
  query?: string;
}): Promise<OwnerKnowledgeDashboard> {
  const snapshot = await getOwnerContext({
    userId: input.userId,
    scene: "dashboard",
    query: input.query,
    maxItems: input.limit,
  });
  return {
    ...snapshot,
    interfaceVersion: OWNER_CONTEXT_INTERFACE_VERSION,
  };
}

export async function listOwnerContextCandidates(input: {
  userId: string;
  limit?: number;
  statuses?: string[];
}): Promise<OwnerContextCandidateListResult> {
  const statuses = input.statuses?.length ? input.statuses : ["candidate"];
  const wiki = await listInteractionWiki({
    userId: input.userId,
    limit: clampLimit(input.limit),
    statuses,
  });
  return listOwnerContextCandidatesFromLegacy({ wiki, statuses });
}

export async function reviewOwnerContextCandidate(input: {
  userId: string;
  kind: OwnerContextCandidateKind;
  id: string;
  decision: OwnerContextCandidateDecision;
}): Promise<OwnerContextCandidateReviewResult> {
  const status = input.decision === "confirmed" ? "confirmed" : "dismissed";
  if (input.kind === "task") {
    const task = await updateInteractionTaskStatus({
      userId: input.userId,
      id: input.id,
      status,
    });
    await writeBrainReview({
      userId: input.userId,
      memory: taskToReviewedBrainMemory({
        userId: input.userId,
        task,
        decision: input.decision,
      }),
      decision: input.decision,
      legacyKind: input.kind,
      legacyId: input.id,
    });
    return {
      kind: input.kind,
      decision: input.decision,
      item: toTaskItem(task),
    };
  }

  const memory = await updateInteractionMemoryStatus({
    userId: input.userId,
    id: input.id,
    status,
  });
  const metadata = record(memory.metadata);
  if (metadata.source !== "brain") {
    const brainMemory = interactionMemoryToReviewedBrainMemory({
      userId: input.userId,
      memory,
      decision: input.decision,
    });
    if (brainMemory) {
      await writeBrainReview({
        userId: input.userId,
        memory: brainMemory,
        decision: input.decision,
        legacyKind: input.kind,
        legacyId: input.id,
      });
    }
  }
  return {
    kind: input.kind,
    decision: input.decision,
    item: ownerContextItemFromInteractionMemory(memory),
  };
}

export async function processOwnerContextMessages(input: {
  userId: string;
  eventIds: string[];
  fallbackToSummary?: boolean;
  processingMode?: InteractionProcessingMode;
}) {
  return processInteractionEvents({
    userId: input.userId,
    eventIds: input.eventIds,
    fallbackToSummary: input.fallbackToSummary,
    processingMode: input.processingMode,
  });
}

export async function getOwnerContextEvidence(input: {
  userId: string;
  eventIds: string[];
}) {
  return getInteractionEventsByIds({
    userId: input.userId,
    ids: input.eventIds,
  });
}

export async function resetOwnerKnowledge(input: {
  userId: string;
  reason?: string | null;
}): Promise<OwnerKnowledgeResetResult> {
  const [wiki, graph] = await Promise.all([
    clearInteractionWikiItems({
      userId: input.userId,
      reason: input.reason ?? "owner_context_reset",
    }),
    clearInteractionGraph({
      userId: input.userId,
    }),
  ]);
  return {
    ...wiki,
    ...graph,
    deletedCount: wiki.deletedCount + graph.deletedGraphCount,
  };
}
