import { getBrainMemory, listBrainSnapshots } from "@/lib/brain/service";
import type { BrainMemory } from "@/lib/brain/types";
import { listInteractionSourcePolicies } from "@/lib/knowledge-pipeline/source-policies";
import { readWechatDigestProjection } from "./digest-projection";
import { taskState } from "./task-state";
import type {
  InteractionEvent,
  InteractionMemory,
  InteractionNote,
  InteractionTask,
} from "@/lib/db/schema";
import {
  getInteractionEventsByIds,
  listInteractionEvents,
  listInteractionWiki,
} from "./service";

export type WechatTodoDigest = {
  interfaceVersion: "wechat-todo-digest.v2";
  generatedAt: string;
  lastSourceObservedAt: string | null;
  lastSourceCollectedAt: string | null;
  lastIngestSucceededAt: string | null;
  scope: {replyNeededEvents: "wechat_observation_window"; backlog: "user_unresolved" | "authorized_work_unresolved"};
  pagination: Record<string, {total: number; returned: number; hasMore: boolean; cursor: string | null}>;
  attentionItems: Array<{id: string; kind: "risk" | "task" | "reply" | "memory"; priority: number; reason: string; item: unknown}>;
  window: {
    since: string | null;
    until: string;
  };
  counts: {
    pendingTasks: number;
    replyNeededEvents: number;
    riskNotes: number;
    memoryCandidates: number;
  };
  pendingTasks: InteractionTask[];
  replyNeededEvents: InteractionEvent[];
  riskNotes: InteractionNote[];
  memoryCandidates: InteractionMemory[];
};

export type WechatScenarioContext = {
  interfaceVersion: "wechat-scenario-context.v1";
  count: number;
  scenarios: Awaited<ReturnType<typeof listBrainSnapshots>>;
};

export type WechatMemoryEvidence = {
  interfaceVersion: "wechat-memory-evidence.v1";
  memory: BrainMemory | null;
  requestedEventIds: string[];
  events: InteractionEvent[];
  unresolvedEventIds: string[];
};

function sinceDate(days: number | undefined) {
  if (!days || !Number.isFinite(days) || days <= 0) return undefined;
  return new Date(Date.now() - Math.trunc(days) * 24 * 60 * 60 * 1000);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringList(value: unknown) {
  return Array.isArray(value)
    ? value.map((item) => String(item).trim()).filter(Boolean)
    : [];
}

async function allowedWechatConversationIds(input: {
  userId: string;
  requesterWorkId?: string | null;
}) {
  if (!input.requesterWorkId) return null;
  const policies = await listInteractionSourcePolicies({
    userId: input.userId,
    platform: "wechat",
  });
  return new Set(
    policies
      .filter((policy) => policy.enabled && policy.policy !== "ignore")
      .filter((policy) => {
        const allowedWorkIds = stringList(policy.metadata.allowedWorkIds);
        const allowedWorkshopIds = stringList(policy.metadata.allowedWorkshopIds);
        return (
          allowedWorkIds.includes(input.requesterWorkId ?? "") ||
          allowedWorkshopIds.includes(input.requesterWorkId ?? "")
        );
      })
      .map((policy) => policy.sourceId),
  );
}

function eventAllowedForWorkbench(
  event: InteractionEvent,
  allowedConversationIds: Set<string> | null,
) {
  if (!allowedConversationIds) return true;
  return Boolean(
    event.conversationId && allowedConversationIds.has(event.conversationId),
  );
}

function latestScenarioKey(
  snapshot: Awaited<ReturnType<typeof listBrainSnapshots>>[number],
) {
  const content = asRecord(snapshot.content);
  const metadata = asRecord(snapshot.metadata);
  const type = String(content.scenarioType ?? metadata.scenarioType ?? "");
  const key = String(content.scenarioKey ?? metadata.scenarioKey ?? "");
  return type && key ? `${type}:${key}` : "";
}

export async function buildWechatTodoDigest(input: {
  cursor?: string;
  userId: string;
  limit?: number;
  sinceDays?: number;
  requesterWorkId?: string | null;
}): Promise<WechatTodoDigest> {
  const limit = Math.min(100, Math.max(1, Math.trunc(input.limit ?? 30)));
  const since = sinceDate(input.sinceDays);
  const allowedConversationIds = await allowedWechatConversationIds(input);
  const projection = await readWechatDigestProjection({
    userId: input.userId, allowedConversationIds: allowedConversationIds ? [...allowedConversationIds] : null,
    since, limit, offset: input.cursor ? Number(input.cursor) : 0,
  });
  const pendingTasks = projection.tasks.items.map(task => ({...task, taskState: taskState(task)}));
  const riskNotes = projection.risks.items;
  const actionableEvents = projection.replies.items;
  const memoryCandidates = projection.memories.items;
  const attentionItems: WechatTodoDigest["attentionItems"] = [
    ...riskNotes.map(item => ({id: item.id, kind: "risk" as const, priority: 0, reason: "unresolved_risk", item})),
    ...pendingTasks.map(item => ({id: item.id, kind: "task" as const,
      priority: item.taskState.dueAt && !item.taskState.needsTimeReview && Date.parse(item.taskState.dueAt) < Date.parse(projection.asOf) ? 1 : 3,
      reason: item.taskState.needsTimeReview ? "deadline_needs_review" : "pending_task", item})),
    ...actionableEvents.map(item => ({id: item.id, kind: "reply" as const, priority: 2, reason: "reply_needed", item})),
    ...memoryCandidates.map(item => ({id: item.id, kind: "memory" as const, priority: 4, reason: "memory_candidate", item})),
  ].sort((a,b) => a.priority - b.priority);
  const pagination = Object.fromEntries(Object.entries({pendingTasks: projection.tasks, riskNotes: projection.risks,
    replyNeededEvents: projection.replies, memoryCandidates: projection.memories}).map(([key, value]) => [key,
      {total: value.total, returned: value.returned, hasMore: value.hasMore, cursor: value.cursor}]));
  return {
    interfaceVersion: "wechat-todo-digest.v2", generatedAt: projection.asOf,
    lastSourceObservedAt: projection.lastSourceObservedAt, lastSourceCollectedAt: projection.lastSourceCollectedAt,
    lastIngestSucceededAt: null,
    scope: {replyNeededEvents: "wechat_observation_window", backlog: input.requesterWorkId ? "authorized_work_unresolved" : "user_unresolved"},
    window: {since: since?.toISOString() ?? null, until: projection.asOf},
    counts: {pendingTasks: projection.tasks.total, replyNeededEvents: projection.replies.total,
      riskNotes: projection.risks.total, memoryCandidates: projection.memories.total},
    pagination, attentionItems, pendingTasks, replyNeededEvents: actionableEvents, riskNotes, memoryCandidates,
  };
}

export async function getWechatScenarioContext(input: {
  userId: string;
  type?: string;
  key?: string;
  limit?: number;
  requesterWorkId?: string | null;
}): Promise<WechatScenarioContext> {
  const limit = Math.min(100, Math.max(1, Math.trunc(input.limit ?? 30)));
  const snapshots = await listBrainSnapshots({
    userId: input.userId,
    snapshotTypes: ["wechat_scenario_state"],
    limit: Math.min(200, limit * 4),
  });
  const allowedConversationIds = await allowedWechatConversationIds({
    userId: input.userId,
    requesterWorkId: input.requesterWorkId,
  });
  let allowedEventIds: Set<string> | null = null;
  if (allowedConversationIds) {
    const candidateEventIds = [
      ...new Set(
        snapshots.flatMap((snapshot) =>
          stringList(asRecord(snapshot.content).sourceEventIds),
        ),
      ),
    ];
    const events = await getInteractionEventsByIds({
      userId: input.userId,
      ids: candidateEventIds,
    });
    allowedEventIds = new Set(
      events
        .filter((event) =>
          eventAllowedForWorkbench(event, allowedConversationIds),
        )
        .map((event) => event.id),
    );
  }
  const latest = new Map<string, (typeof snapshots)[number]>();
  for (const snapshot of snapshots) {
    const content = asRecord(snapshot.content);
    if (input.type && content.scenarioType !== input.type) continue;
    if (input.key && content.scenarioKey !== input.key) continue;
    if (allowedEventIds) {
      const sourceEventIds = stringList(content.sourceEventIds);
      if (
        sourceEventIds.length === 0 ||
        !sourceEventIds.every((eventId) => allowedEventIds?.has(eventId))
      ) {
        continue;
      }
    }
    const scenarioKey = latestScenarioKey(snapshot);
    if (!scenarioKey || latest.has(scenarioKey)) continue;
    latest.set(scenarioKey, snapshot);
    if (latest.size >= limit) break;
  }
  const scenarios = [...latest.values()];
  return {
    interfaceVersion: "wechat-scenario-context.v1",
    count: scenarios.length,
    scenarios,
  };
}

export async function getWechatMemoryEvidence(input: {
  userId: string;
  memoryId?: string;
  eventIds?: string[];
  maxEvents?: number;
  requesterWorkId?: string | null;
}): Promise<WechatMemoryEvidence> {
  const memory = input.memoryId
    ? await getBrainMemory({ userId: input.userId, memoryId: input.memoryId })
    : null;
  const maxEvents = Math.min(50, Math.max(1, Math.trunc(input.maxEvents ?? 10)));
  const requestedEventIds = [
    ...new Set([...(input.eventIds ?? []), ...(memory?.evidenceRefs ?? [])]),
  ]
    .filter(Boolean)
    .slice(0, maxEvents);
  const events = await getInteractionEventsByIds({
    userId: input.userId,
    ids: requestedEventIds,
  });
  const allowedConversationIds = await allowedWechatConversationIds({
    userId: input.userId,
    requesterWorkId: input.requesterWorkId,
  });
  const allowedEvents = events.filter((event) =>
    eventAllowedForWorkbench(event, allowedConversationIds),
  );
  const resolvedIds = new Set(allowedEvents.map((event) => event.id));
  const memoryAllowed =
    !allowedConversationIds ||
    !memory ||
    (memory.evidenceRefs.length > 0 && memory.evidenceRefs.every((eventId) => resolvedIds.has(eventId)));
  return {
    interfaceVersion: "wechat-memory-evidence.v1",
    memory: memoryAllowed ? memory : null,
    requestedEventIds,
    events: allowedEvents,
    unresolvedEventIds: requestedEventIds.filter((id) => !resolvedIds.has(id)),
  };
}
