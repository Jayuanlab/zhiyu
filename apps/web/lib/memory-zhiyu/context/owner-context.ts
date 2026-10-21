import type {
  OwnerContextCandidateListResult,
  OwnerContextConversation,
  OwnerContextGraphSummary,
  OwnerContextItem,
  OwnerContextRequest,
  OwnerContextScene,
  OwnerContextSnapshot,
} from "@/lib/owner-context/types";

export type LegacyOwnerContextWiki = {
  notes?: unknown[];
  tasks?: unknown[];
  memories?: unknown[];
};

export type LegacyOwnerContextInput = {
  userId: string;
  scene?: OwnerContextScene;
  query?: string;
  wiki: LegacyOwnerContextWiki;
  events: unknown[];
  graphSnapshot: unknown;
  generatedAt?: string;
};

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

function normalizedText(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

function matchesQuery(item: OwnerContextItem, query: string) {
  if (!query) return true;
  const haystack = [
    item.title,
    item.body,
    item.kind,
    item.state,
    item.source,
    ...(item.tags ?? []),
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(query);
}

function compareByTime(a: OwnerContextItem, b: OwnerContextItem) {
  return (
    new Date(b.updatedAt ?? b.createdAt ?? 0).getTime() -
    new Date(a.updatedAt ?? a.createdAt ?? 0).getTime()
  );
}

function toNoteItem(note: any): OwnerContextItem {
  return {
    id: String(note.id),
    kind: "note",
    title: String(note.title ?? "Knowledge note"),
    body: String(note.body ?? ""),
    state: "confirmed",
    source: "interaction_wiki",
    confidence: typeof note.confidence === "number" ? note.confidence : null,
    sourceEventIds: stringArray(note.sourceEventIds),
    metadata: record(note.metadata),
    createdAt: isoDate(note.createdAt),
    updatedAt: isoDate(note.updatedAt ?? note.createdAt),
  };
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

export function ownerContextItemFromInteractionMemory(memory: any): OwnerContextItem {
  const status = String(memory.status ?? "candidate");
  return {
    id: String(memory.id),
    kind: "memory",
    title: String(memory.subject ?? "Long-term memory"),
    body: String(memory.content ?? ""),
    state:
      status === "confirmed"
        ? "confirmed"
        : status === "dismissed" || status === "archived"
          ? "dismissed"
          : "candidate",
    source: "interaction_wiki",
    confidence:
      typeof memory.confidence === "number" ? memory.confidence : null,
    tags: stringArray(memory.tags),
    sourceEventIds: stringArray(memory.sourceEventIds),
    metadata: {
      ...record(memory.metadata),
      memoryType: memory.memoryType ?? null,
      lastVerifiedAt: isoDate(memory.lastVerifiedAt),
      expiresAt: isoDate(memory.expiresAt),
    },
    createdAt: isoDate(memory.createdAt),
    updatedAt: isoDate(memory.updatedAt ?? memory.createdAt),
  };
}

function toEventItem(event: any): OwnerContextItem {
  const sender = String(
    event.senderDisplayName ?? event.senderName ?? event.senderId ?? "Unknown",
  );
  return {
    id: String(event.id),
    kind: "raw_event",
    title: `${String(event.conversationName ?? "Conversation")} / ${sender}`,
    body: String(event.contentPreview ?? event.content ?? ""),
    state: "raw",
    source: "wechat",
    metadata: {
      platform: event.platform,
      conversationId: event.conversationId,
      conversationType: event.conversationType,
      sender,
      messageTime: isoDate(event.messageTime),
      processedStatus: event.processedStatus,
      importance: event.importance,
    },
    createdAt: isoDate(event.messageTime),
    updatedAt: isoDate(event.collectedAt ?? event.messageTime),
  };
}

function conversationsFromEvents(events: any[]): OwnerContextConversation[] {
  const buckets = new Map<string, OwnerContextConversation>();
  for (const event of events) {
    const conversationId = String(event.conversationId ?? "");
    if (!conversationId) continue;
    const current = buckets.get(conversationId);
    const messageTime = isoDate(event.messageTime);
    if (!current) {
      buckets.set(conversationId, {
        conversationId,
        conversationName: String(event.conversationName ?? conversationId),
        conversationType: String(event.conversationType ?? "unknown"),
        lastMessageAt: messageTime,
        messageCount: 1,
      });
      continue;
    }
    current.messageCount += 1;
    if (
      messageTime &&
      (!current.lastMessageAt ||
        new Date(messageTime).getTime() >
          new Date(current.lastMessageAt).getTime())
    ) {
      current.lastMessageAt = messageTime;
    }
  }
  return [...buckets.values()].sort(
    (a, b) =>
      new Date(b.lastMessageAt ?? 0).getTime() -
      new Date(a.lastMessageAt ?? 0).getTime(),
  );
}

function graphItem(entity: any, kind: "person" | "project"): OwnerContextItem {
  return {
    id: String(entity.id),
    kind,
    title: String(entity.name ?? entity.normalizedName ?? "Unnamed entity"),
    body: String(entity.description ?? ""),
    state: "confirmed",
    source: "graph",
    tags: stringArray(entity.aliases),
    metadata: {
      ...record(entity.metadata),
      entityType: entity.entityType,
      lastSeenAt: isoDate(entity.lastSeenAt),
    },
    createdAt: isoDate(entity.firstSeenAt),
    updatedAt: isoDate(entity.lastSeenAt),
  };
}

function relationItem(relation: any): OwnerContextItem {
  return {
    id: String(relation.id),
    kind: "relation",
    title: String(relation.relationType ?? "relation"),
    body: String(relation.claim ?? ""),
    state: relation.status === "active" ? "confirmed" : "candidate",
    source: "graph",
    confidence:
      typeof relation.confidence === "number" ? relation.confidence : null,
    metadata: {
      ...record(relation.metadata),
      subjectEntityId: relation.subjectEntityId,
      objectEntityId: relation.objectEntityId,
      evidenceStrength: relation.evidenceStrength,
      status: relation.status,
    },
    createdAt: isoDate(relation.firstSeenAt),
    updatedAt: isoDate(relation.updatedAt ?? relation.lastSeenAt),
  };
}

function summarizeGraph(
  graphSnapshot: unknown,
  query: string,
): OwnerContextGraphSummary {
  const graph = record(graphSnapshot);
  const entities: any[] = Array.isArray(graph.entities) ? graph.entities : [];
  const relations: any[] = Array.isArray(graph.relations)
    ? graph.relations
    : [];
  const stats = record(graph.stats);
  const peopleTypes = new Set(["person", "group"]);
  const projectTypes = new Set([
    "project",
    "organization",
    "topic",
    "memory_topic",
    "preference",
    "boundary",
  ]);
  const people = entities
    .filter((entity) => peopleTypes.has(String(entity.entityType)))
    .map((entity) => graphItem(entity, "person"))
    .filter((item) => matchesQuery(item, query))
    .sort(compareByTime)
    .slice(0, 60);
  const projects = entities
    .filter((entity) => projectTypes.has(String(entity.entityType)))
    .map((entity) => graphItem(entity, "project"))
    .filter((item) => matchesQuery(item, query))
    .sort(compareByTime)
    .slice(0, 80);
  const relationItems = relations
    .map((relation) => relationItem(relation))
    .filter((item) => matchesQuery(item, query))
    .sort(compareByTime)
    .slice(0, 120);

  return {
    entityCount: Number(stats.entityCount ?? entities.length),
    relationCount: Number(stats.relationCount ?? relations.length),
    activeRelationCount: Number(
      stats.activeRelationCount ??
        relations.filter((relation: any) => relation.status === "active")
          .length,
    ),
    evidenceCount: Number(stats.evidenceCount ?? 0),
    people,
    projects,
    relations: relationItems,
  };
}

function resolveScene(scene: OwnerContextRequest["scene"]): OwnerContextScene {
  return scene ?? "dashboard";
}

export function buildOwnerContextSnapshotFromLegacy(
  input: LegacyOwnerContextInput,
): OwnerContextSnapshot {
  const query = normalizedText(input.query);
  const notes = (input.wiki.notes ?? [])
    .map(toNoteItem)
    .filter((item) => matchesQuery(item, query))
    .sort(compareByTime);
  const tasks = (input.wiki.tasks ?? [])
    .map(toTaskItem)
    .filter((item) => matchesQuery(item, query))
    .sort(compareByTime);
  const memoryItems = (input.wiki.memories ?? [])
    .map(ownerContextItemFromInteractionMemory)
    .filter((item) => matchesQuery(item, query))
    .sort(compareByTime);
  const confirmedMemories = memoryItems.filter(
    (item) => item.state === "confirmed",
  );
  const candidates = [
    ...tasks.filter((item) => item.state === "candidate"),
    ...memoryItems.filter((item) => item.state === "candidate"),
  ].sort(compareByTime);
  const recentEvents = input.events
    .map(toEventItem)
    .filter((item) => matchesQuery(item, query))
    .sort(compareByTime);
  const graph = summarizeGraph(input.graphSnapshot, query);
  const conversations = conversationsFromEvents(input.events);
  const warnings = [
    "Owner Context is served through the Brain legacy adapter; legacy interaction tables remain the backing store during migration.",
  ];
  if (confirmedMemories.length === 0) {
    warnings.push(
      "No confirmed owner memories are available; use raw evidence, candidates, and graph context until review confirms them.",
    );
  }

  return {
    scene: resolveScene(input.scene),
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    stats: {
      rawEventCount: recentEvents.length,
      taskCount: tasks.length,
      candidateCount: candidates.length,
      confirmedMemoryCount: confirmedMemories.length,
      noteCount: notes.length,
      graphEntityCount: graph.entityCount,
      graphRelationCount: graph.relationCount,
    },
    tasks,
    candidates,
    confirmedMemories,
    notes,
    recentEvents,
    conversations,
    graph,
    warnings,
  };
}

export function listOwnerContextCandidatesFromLegacy(input: {
  wiki: LegacyOwnerContextWiki;
  statuses: string[];
  generatedAt?: string;
}): OwnerContextCandidateListResult {
  const tasks = (input.wiki.tasks ?? []).map(toTaskItem);
  const memories = (input.wiki.memories ?? []).map(
    ownerContextItemFromInteractionMemory,
  );
  const candidates = [...tasks, ...memories].sort(compareByTime);
  return {
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    statuses: input.statuses,
    candidates,
    stats: {
      taskCount: tasks.length,
      memoryCount: memories.length,
      totalCount: candidates.length,
    },
  };
}
