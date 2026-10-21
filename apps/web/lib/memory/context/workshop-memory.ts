import type { Workshop, WorkshopMemory } from "@/lib/db/schema";
import type { WorkshopMemoryContextItem, WorkshopMemoryContextPack } from "@/lib/workshops/memory-context";
import type { WorkshopMemoryKind } from "@/lib/workshops/types";
import { buildBrainContextPack, type BrainRecallProfile } from "./pack";
import { describeMemoryUse } from "../kernel/memory-use-semantics";
import { createWorkshopBrainRequester, workshopMemoryToBrainMemory } from "../records/workshop-memory";
import type { BrainAccessGrant, BrainMemoryStatus, BrainMemoryType } from "../kernel/memory-types";

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
    ...(item.supersedes?.length ? { supersedes: [...item.supersedes] } : {}),
    kind: workshopKindFromBrainType(item.memoryType),
    status: item.status ? workshopStatusFromBrainStatus(item.status) : "unknown",
    content: item.content,
    confidence: typeof item.confidence === 'number' && Number.isFinite(item.confidence)
      ? item.confidence : null,
    tags: ["brain"],
    sourceEventIds: item.evidenceRefs,
    score: Math.round(item.score),
    reasons: [
      "brain_context",
      ...item.reasons,
      ...(item.warnings ?? []).map((warning) => `warning:${warning}`),
    ],
    useSemantics: item.useSemantics ?? describeMemoryUse(item),
    ...(item.scenarioApplicability ? { scenarioApplicability: item.scenarioApplicability } : {}),
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
    correctionMemoryIds: [...new Set([
      ...items.filter(item => item.supersedes?.length || item.reasons.some(reason =>
        reason === 'warning:memory_update_pending' || reason === 'warning:content_reports_conflict')).map(item => item.id),
      ...input.pack.omitted.filter(item => item.reason === 'deleted' || item.reason === 'superseded').map(item => item.id),
    ])],
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
