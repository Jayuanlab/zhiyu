import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  interactionMemories,
  memoryGraphEntities,
  memoryGraphEvidence,
  memoryGraphRelations,
  type InsertMemoryGraphEntity,
  type InsertMemoryGraphEvidence,
  type InsertMemoryGraphRelation,
  type InteractionEvent,
  type InteractionMemory,
  type MemoryGraphEntity,
  type MemoryGraphEvidence,
  type MemoryGraphRelation,
} from "@/lib/db/schema";
import { deserializeJson, serializeJson } from "@/lib/db/serialization";
import { listBrainMemoriesForUser as listBrainMemory } from "@/lib/memory/retrieval/candidates";
import type { BrainMemory, BrainMemoryStatus } from "@/lib/memory/kernel/memory-types";
import {
  shouldPreferBrainMemory,
  shouldReadLegacyMemoryFallback,
} from "@/lib/memory/retrieval/mode";

export type InteractionGraphEntityInput = {
  name: string;
  type: string;
  role?: string;
};

export type InteractionGraphFactInput = {
  claim: string;
  sourceEventIds: string[];
  evidenceStrength?: "high" | "medium" | "low";
};

export type InteractionGraphAnalysisInput = {
  summary: string;
  topics: string[];
  entities: InteractionGraphEntityInput[];
  facts: InteractionGraphFactInput[];
  decisions: string[];
  commitments: string[];
  risks: string[];
  contradictions: string[];
  recommendations: string[];
};

export type InteractionGraphIndexResult = {
  entities: MemoryGraphEntity[];
  relations: MemoryGraphRelation[];
  evidence: MemoryGraphEvidence[];
};

export type InteractionGraphSearchResult = {
  relation: MemoryGraphRelation;
  subject: MemoryGraphEntity;
  object: MemoryGraphEntity;
  evidence: MemoryGraphEvidence[];
  score: number;
  content: string;
};

export type InteractionGraphSnapshot = {
  entities: MemoryGraphEntity[];
  relations: MemoryGraphRelation[];
  evidence: MemoryGraphEvidence[];
  stats: {
    entityCount: number;
    relationCount: number;
    evidenceCount: number;
    activeRelationCount: number;
  };
};

const GRAPH_SCOPE = "interaction";
const GRAPH_SOURCE = "interaction_processor";

type GraphIndexedMemory = {
  id: string;
  memoryType: string;
  subject: string;
  content: string;
  status: string;
  confidence: number;
  tags: string[];
  sourceEventIds: string[];
  sourceBackend: "brain" | "legacy";
};

function toDbJson(value: unknown) {
  const data =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return serializeJson(data) as Record<string, unknown>;
}

function toDbArray(value: unknown[] | null | undefined) {
  return serializeJson(value ?? []) as unknown[];
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  const parsed = deserializeJson(value as any);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function parseJsonArray<T = unknown>(value: unknown): T[] {
  const parsed = deserializeJson(value as any);
  return Array.isArray(parsed) ? (parsed as T[]) : [];
}

function normalizeEntity<T extends MemoryGraphEntity>(entity: T): T {
  return {
    ...entity,
    aliases: parseJsonArray<string>((entity as any).aliases),
    metadata: parseJsonObject((entity as any).metadata),
  };
}

function normalizeRelation<T extends MemoryGraphRelation>(relation: T): T {
  return {
    ...relation,
    metadata: parseJsonObject((relation as any).metadata),
  };
}

function normalizeEvidence<T extends MemoryGraphEvidence>(evidence: T): T {
  return {
    ...evidence,
    metadata: parseJsonObject((evidence as any).metadata),
  };
}

function compact(value: string | null | undefined, max = 500) {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function normalizeName(value: string) {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function relationHash(input: {
  subjectId: string;
  objectId: string;
  relationType: string;
  claim: string;
}) {
  return createHash("sha256")
    .update(
      [
        input.subjectId,
        input.objectId,
        input.relationType,
        compact(input.claim, 2_000),
      ].join("\n"),
    )
    .digest("hex");
}

function boundedConfidence(value: number | undefined, fallback = 70) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(100, Math.max(0, Math.trunc(parsed)));
}

function cleanEntityType(value: string | undefined) {
  const normalized = normalizeName(value ?? "other").replace(/[^a-z0-9_-]/g, "");
  return (normalized || "other").slice(0, 40);
}

function uniqueStrings(values: Array<string | null | undefined>) {
  return [...new Set(values.map((value) => value?.trim()).filter(Boolean))] as string[];
}

function tokens(value: string) {
  const normalized = normalizeName(value);
  const latin = normalized.split(/[^a-z0-9]+/).filter((item) => item.length >= 2);
  const cjk = Array.from(normalized.matchAll(/[\u4e00-\u9fff]{2,}/g)).map(
    (match) => match[0],
  );
  return [...new Set([...latin, ...cjk, normalized].filter(Boolean))];
}

function scoreText(query: string, text: string) {
  const haystack = normalizeName(text);
  const queryText = normalizeName(query);
  if (!haystack || !queryText) return 0;
  let score = haystack.includes(queryText) ? 0.55 : 0;
  const queryTokens = tokens(queryText);
  if (queryTokens.length > 0) {
    const hits = queryTokens.filter((token) => haystack.includes(token)).length;
    score += (hits / queryTokens.length) * 0.45;
  }
  return Math.min(1, score);
}

async function upsertGraphEntity(input: {
  userId: string;
  name: string;
  entityType: string;
  aliases?: string[];
  description?: string | null;
  metadata?: Record<string, unknown>;
}) {
  const name = input.name.trim();
  if (!name) return null;
  const entityType = cleanEntityType(input.entityType);
  const normalizedName = normalizeName(name);
  const now = new Date();
  const existing = await db
    .select()
    .from(memoryGraphEntities)
    .where(
      and(
        eq(memoryGraphEntities.userId, input.userId),
        eq(memoryGraphEntities.scope, GRAPH_SCOPE),
        eq(memoryGraphEntities.entityType, entityType),
        eq(memoryGraphEntities.normalizedName, normalizedName),
      ),
    )
    .limit(1);

  if (existing[0]) {
    const current = normalizeEntity(existing[0] as MemoryGraphEntity);
    const aliases = uniqueStrings([
      ...current.aliases,
      ...(input.aliases ?? []),
      name,
    ]);
    const [updated] = await db
      .update(memoryGraphEntities)
      .set({
        name: current.name || name,
        aliases: toDbArray(aliases),
        description: input.description ?? current.description ?? null,
        metadata: toDbJson({
          ...current.metadata,
          ...(input.metadata ?? {}),
        }),
        lastSeenAt: now,
        updatedAt: now,
      } as Partial<InsertMemoryGraphEntity>)
      .where(eq(memoryGraphEntities.id, current.id))
      .returning();
    return normalizeEntity(updated as MemoryGraphEntity);
  }

  const [created] = await db
    .insert(memoryGraphEntities)
    .values({
      id: randomUUID(),
      userId: input.userId,
      scope: GRAPH_SCOPE,
      source: GRAPH_SOURCE,
      name,
      normalizedName,
      entityType,
      aliases: toDbArray(uniqueStrings([...(input.aliases ?? []), name])),
      description: input.description ?? null,
      metadata: toDbJson(input.metadata ?? {}),
      firstSeenAt: now,
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now,
    } as InsertMemoryGraphEntity)
    .returning();
  return normalizeEntity(created as MemoryGraphEntity);
}

async function upsertGraphRelation(input: {
  userId: string;
  subject: MemoryGraphEntity;
  object: MemoryGraphEntity;
  relationType: string;
  claim: string;
  confidence?: number;
  evidenceStrength?: string;
  metadata?: Record<string, unknown>;
}) {
  const claim = compact(input.claim, 2_000);
  if (!claim) return null;
  const relationType = cleanEntityType(input.relationType);
  const claimHash = relationHash({
    subjectId: input.subject.id,
    objectId: input.object.id,
    relationType,
    claim,
  });
  const now = new Date();
  const existing = await db
    .select()
    .from(memoryGraphRelations)
    .where(
      and(
        eq(memoryGraphRelations.userId, input.userId),
        eq(memoryGraphRelations.scope, GRAPH_SCOPE),
        eq(memoryGraphRelations.subjectEntityId, input.subject.id),
        eq(memoryGraphRelations.objectEntityId, input.object.id),
        eq(memoryGraphRelations.relationType, relationType),
        eq(memoryGraphRelations.claimHash, claimHash),
      ),
    )
    .limit(1);

  if (existing[0]) {
    const current = normalizeRelation(existing[0] as MemoryGraphRelation);
    const [updated] = await db
      .update(memoryGraphRelations)
      .set({
        confidence: Math.max(
          current.confidence,
          boundedConfidence(input.confidence, current.confidence),
        ),
        evidenceStrength: input.evidenceStrength ?? current.evidenceStrength,
        metadata: toDbJson({
          ...current.metadata,
          ...(input.metadata ?? {}),
        }),
        lastSeenAt: now,
        updatedAt: now,
      } as Partial<InsertMemoryGraphRelation>)
      .where(eq(memoryGraphRelations.id, current.id))
      .returning();
    return normalizeRelation(updated as MemoryGraphRelation);
  }

  const [created] = await db
    .insert(memoryGraphRelations)
    .values({
      id: randomUUID(),
      userId: input.userId,
      scope: GRAPH_SCOPE,
      source: GRAPH_SOURCE,
      subjectEntityId: input.subject.id,
      objectEntityId: input.object.id,
      relationType,
      claim,
      claimHash,
      confidence: boundedConfidence(input.confidence),
      evidenceStrength: input.evidenceStrength ?? "medium",
      status: "active",
      metadata: toDbJson(input.metadata ?? {}),
      firstSeenAt: now,
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now,
    } as InsertMemoryGraphRelation)
    .returning();
  return normalizeRelation(created as MemoryGraphRelation);
}

async function upsertGraphEvidence(input: {
  userId: string;
  relation: MemoryGraphRelation;
  event?: InteractionEvent;
  sourceType?: string;
  sourceId?: string;
  quote?: string;
  metadata?: Record<string, unknown>;
}) {
  const sourceType = input.sourceType ?? "interaction_event";
  const sourceId = input.sourceId ?? input.event?.id;
  if (!sourceId) {
    throw new Error("Graph evidence requires a source id.");
  }

  const existing = await db
    .select()
    .from(memoryGraphEvidence)
    .where(
      and(
        eq(memoryGraphEvidence.relationId, input.relation.id),
        eq(memoryGraphEvidence.sourceType, sourceType),
        eq(memoryGraphEvidence.sourceId, sourceId),
      ),
    )
    .limit(1);
  if (existing[0]) return normalizeEvidence(existing[0] as MemoryGraphEvidence);

  const [created] = await db
    .insert(memoryGraphEvidence)
    .values({
      id: randomUUID(),
      userId: input.userId,
      relationId: input.relation.id,
      sourceType,
      sourceId,
      eventId: input.event?.id ?? null,
      quote: compact(
        input.quote ?? input.event?.contentPreview ?? input.event?.content,
      ),
      metadata: toDbJson(input.metadata ?? {}),
      createdAt: new Date(),
    } as InsertMemoryGraphEvidence)
    .returning();
  return normalizeEvidence(created as MemoryGraphEvidence);
}

function conversationEntityInput(events: InteractionEvent[]) {
  const first = events[0];
  if (!first) return null;
  return {
    name: first.conversationName,
    entityType: first.conversationType === "group" ? "group" : "person",
    metadata: {
      platform: first.platform,
      conversationId: first.conversationId,
      conversationType: first.conversationType,
    },
  };
}

function sourceEventsForClaim(
  eventsById: Map<string, InteractionEvent>,
  sourceEventIds: string[],
) {
  return sourceEventIds
    .map((id) => eventsById.get(id))
    .filter((event): event is InteractionEvent => Boolean(event));
}

function relationObjectName(input: {
  relationType: string;
  topics: string[];
  claim: string;
}) {
  const topic = input.topics.find((item) => item.trim());
  if (topic) return topic.trim();
  const labels: Record<string, string> = {
    fact: "交互事实",
    decision: "决策",
    commitment: "承诺",
    risk: "风险",
    contradiction: "矛盾",
    recommendation: "建议",
    summary: "摘要",
  };
  return labels[input.relationType] ?? compact(input.claim, 40);
}

export async function indexInteractionAnalysisToGraph(input: {
  userId: string;
  events: InteractionEvent[];
  analysis: InteractionGraphAnalysisInput | undefined;
  model?: string;
}): Promise<InteractionGraphIndexResult> {
  if (!input.analysis || input.events.length === 0) {
    return { entities: [], relations: [], evidence: [] };
  }

  const entities: MemoryGraphEntity[] = [];
  const relations: MemoryGraphRelation[] = [];
  const evidence: MemoryGraphEvidence[] = [];
  const eventsById = new Map(input.events.map((event) => [event.id, event]));
  const conversationInput = conversationEntityInput(input.events);
  const conversationEntity = conversationInput
    ? await upsertGraphEntity({
        userId: input.userId,
        ...conversationInput,
        aliases: [conversationInput.name],
      })
    : null;
  if (conversationEntity) entities.push(conversationEntity);

  const explicitEntities = [];
  for (const entity of input.analysis.entities) {
    const graphEntity = await upsertGraphEntity({
      userId: input.userId,
      name: entity.name,
      entityType: entity.type,
      aliases: [entity.name],
      description: entity.role,
      metadata: {
        role: entity.role,
        model: input.model,
      },
    });
    if (graphEntity) explicitEntities.push(graphEntity);
  }
  entities.push(...explicitEntities);

  if (conversationEntity) {
    for (const entity of explicitEntities) {
      const relation = await upsertGraphRelation({
        userId: input.userId,
        subject: conversationEntity,
        object: entity,
        relationType: "mentions",
        claim: `${conversationEntity.name} 提到了 ${entity.name}`,
        confidence: 70,
        evidenceStrength: "medium",
        metadata: { generatedBy: GRAPH_SOURCE, model: input.model },
      });
      if (relation) {
        relations.push(relation);
        for (const event of input.events.slice(0, 5)) {
          evidence.push(
            await upsertGraphEvidence({
              userId: input.userId,
              relation,
              event,
            }),
          );
        }
      }
    }
  }

  const defaultSubject = explicitEntities[0] ?? conversationEntity;
  if (!defaultSubject) {
    return { entities, relations, evidence };
  }

  const addClaim = async (claimInput: {
    relationType: string;
    claim: string;
    sourceEventIds?: string[];
    evidenceStrength?: string;
    confidence?: number;
  }) => {
    const object = await upsertGraphEntity({
      userId: input.userId,
      name: relationObjectName({
        relationType: claimInput.relationType,
        topics: input.analysis?.topics ?? [],
        claim: claimInput.claim,
      }),
      entityType:
        claimInput.relationType === "risk" ? "risk" : "topic",
      aliases: input.analysis?.topics ?? [],
      metadata: { generatedBy: GRAPH_SOURCE, model: input.model },
    });
    if (!object) return;
    entities.push(object);
    const relation = await upsertGraphRelation({
      userId: input.userId,
      subject: defaultSubject,
      object,
      relationType: claimInput.relationType,
      claim: claimInput.claim,
      confidence: claimInput.confidence ?? 75,
      evidenceStrength: claimInput.evidenceStrength ?? "medium",
      metadata: {
        generatedBy: GRAPH_SOURCE,
        model: input.model,
        topics: input.analysis?.topics ?? [],
      },
    });
    if (!relation) return;
    relations.push(relation);
    const sourceEvents =
      claimInput.sourceEventIds?.length
        ? sourceEventsForClaim(eventsById, claimInput.sourceEventIds)
        : input.events.slice(0, 5);
    for (const event of sourceEvents) {
      evidence.push(
        await upsertGraphEvidence({
          userId: input.userId,
          relation,
          event,
        }),
      );
    }
  };

  await addClaim({
    relationType: "summary",
    claim: input.analysis.summary,
    sourceEventIds: input.events.map((event) => event.id),
    confidence: 65,
  });
  for (const fact of input.analysis.facts) {
    await addClaim({
      relationType: "fact",
      claim: fact.claim,
      sourceEventIds: fact.sourceEventIds,
      evidenceStrength: fact.evidenceStrength,
      confidence: fact.evidenceStrength === "high" ? 85 : 70,
    });
  }
  for (const claim of input.analysis.decisions) {
    await addClaim({ relationType: "decision", claim, confidence: 75 });
  }
  for (const claim of input.analysis.commitments) {
    await addClaim({ relationType: "commitment", claim, confidence: 80 });
  }
  for (const claim of input.analysis.risks) {
    await addClaim({ relationType: "risk", claim, confidence: 75 });
  }
  for (const claim of input.analysis.contradictions) {
    await addClaim({
      relationType: "contradiction",
      claim,
      confidence: 75,
      evidenceStrength: "low",
    });
  }
  for (const claim of input.analysis.recommendations) {
    await addClaim({ relationType: "recommendation", claim, confidence: 65 });
  }

  return {
    entities: dedupeById(entities),
    relations: dedupeById(relations),
    evidence: dedupeById(evidence),
  };
}

function normalizeInteractionMemory(memory: InteractionMemory): InteractionMemory {
  return {
    ...memory,
    tags: parseJsonArray<string>((memory as any).tags),
    sourceEventIds: parseJsonArray<string>((memory as any).sourceEventIds),
    metadata: parseJsonObject((memory as any).metadata),
  };
}

function brainStatusesFromInteractionStatuses(statuses: string[]) {
  const mapped = new Set<BrainMemoryStatus>();
  for (const status of statuses) {
    if (status === "candidate") mapped.add("candidate");
    if (status === "confirmed") {
      mapped.add("active");
      mapped.add("verified");
    }
    if (status === "archived") mapped.add("weakened");
    if (status === "dismissed" || status === "deleted") mapped.add("deleted");
  }
  return [...mapped];
}

function brainStatusToInteractionStatus(status: BrainMemoryStatus) {
  switch (status) {
    case "candidate":
      return "candidate";
    case "active":
    case "verified":
      return "confirmed";
    case "weakened":
      return "archived";
    case "deleted":
      return "deleted";
    default:
      return "candidate";
  }
}

function brainMemoryToGraphIndexedMemory(
  memory: BrainMemory,
): GraphIndexedMemory {
  return {
    id: memory.id,
    memoryType: memory.memoryType,
    subject: memory.subject,
    content: memory.content,
    status: brainStatusToInteractionStatus(memory.status),
    confidence: memory.confidence,
    tags: uniqueStrings(memory.tags ?? []),
    sourceEventIds: uniqueStrings(memory.evidenceRefs),
    sourceBackend: "brain",
  };
}

function interactionMemoryToGraphIndexedMemory(
  memory: InteractionMemory,
): GraphIndexedMemory {
  const normalized = normalizeInteractionMemory(memory);
  return {
    id: normalized.id,
    memoryType: normalized.memoryType,
    subject: normalized.subject,
    content: normalized.content,
    status: normalized.status,
    confidence: normalized.confidence,
    tags: uniqueStrings(normalized.tags),
    sourceEventIds: uniqueStrings(normalized.sourceEventIds),
    sourceBackend: "legacy",
  };
}

export async function indexInteractionMemoriesToGraph(input: {
  userId: string;
  limit?: number;
  statuses?: string[];
}): Promise<InteractionGraphIndexResult & { scanned: number }> {
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 200), 1), 1_000);
  const statuses = input.statuses?.length ? input.statuses : ["confirmed"];
  const brainStatuses = brainStatusesFromInteractionStatuses(statuses);
  const preferBrain = shouldPreferBrainMemory();
  const allowLegacyFallback = shouldReadLegacyMemoryFallback();
  const brainRows =
    preferBrain && brainStatuses.length > 0
      ? await listBrainMemory({
          userId: input.userId,
          limit,
          statuses: brainStatuses,
          ownerType: "chat",
          ownerId: input.userId,
        })
      : [];
  const rows =
    preferBrain && brainRows.length > 0
      ? brainRows.map(brainMemoryToGraphIndexedMemory)
      : allowLegacyFallback
        ? ((await db
          .select()
          .from(interactionMemories)
          .where(
            and(
              eq(interactionMemories.userId, input.userId),
              inArray(interactionMemories.status, statuses),
            ),
          )
          .orderBy(desc(interactionMemories.updatedAt))
          .limit(limit)) as InteractionMemory[]).map(
          interactionMemoryToGraphIndexedMemory,
        )
        : [];

  const entities: MemoryGraphEntity[] = [];
  const relations: MemoryGraphRelation[] = [];
  const evidence: MemoryGraphEvidence[] = [];

  for (const memory of rows) {
    const tags = uniqueStrings(memory.tags);
    const subject = await upsertGraphEntity({
      userId: input.userId,
      name: memory.subject,
      entityType: memory.memoryType,
      aliases: [memory.subject],
      metadata: {
        generatedBy:
          memory.sourceBackend === "brain"
            ? "brain_memory_index"
            : "interaction_memory_backfill",
        memoryId: memory.id,
        memoryType: memory.memoryType,
        status: memory.status,
        tags,
        sourceBackend: memory.sourceBackend,
      },
    });
    const object = await upsertGraphEntity({
      userId: input.userId,
      name: tags[0] ?? `记忆：${memory.memoryType}`,
      entityType: "memory_topic",
      aliases: tags,
      metadata: {
        generatedBy:
          memory.sourceBackend === "brain"
            ? "brain_memory_index"
            : "interaction_memory_backfill",
        memoryType: memory.memoryType,
        sourceBackend: memory.sourceBackend,
      },
    });
    if (!subject || !object) continue;

    entities.push(subject, object);
    const relation = await upsertGraphRelation({
      userId: input.userId,
      subject,
      object,
      relationType: `memory_${memory.memoryType}`,
      claim: `${memory.subject}: ${memory.content}`,
      confidence: memory.confidence,
      evidenceStrength: memory.status === "confirmed" ? "high" : "medium",
      metadata: {
        generatedBy:
          memory.sourceBackend === "brain"
            ? "brain_memory_index"
            : "interaction_memory_backfill",
        memoryId: memory.id,
        memoryType: memory.memoryType,
        status: memory.status,
        tags,
        sourceEventIds: memory.sourceEventIds,
        sourceBackend: memory.sourceBackend,
      },
    });
    if (!relation) continue;

    relations.push(relation);
    evidence.push(
      await upsertGraphEvidence({
        userId: input.userId,
      relation,
      sourceType: "interaction_memory",
      sourceId: memory.id,
        quote: memory.content,
        metadata: {
          status: memory.status,
          tags,
          sourceEventIds: memory.sourceEventIds,
        },
      }),
    );
  }

  return {
    scanned: rows.length,
    entities: dedupeById(entities),
    relations: dedupeById(relations),
    evidence: dedupeById(evidence),
  };
}

function dedupeById<T extends { id: string }>(items: T[]) {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

function relationContent(input: {
  relation: MemoryGraphRelation;
  subject: MemoryGraphEntity;
  object: MemoryGraphEntity;
  evidence: MemoryGraphEvidence[];
}) {
  const evidenceIds = input.evidence
    .map((item) => item.sourceId)
    .filter(Boolean)
    .slice(0, 5)
    .join(", ");
  return [
    `${input.subject.name} -[${input.relation.relationType}]-> ${input.object.name}`,
    input.relation.claim,
    evidenceIds ? `证据: ${evidenceIds}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export { searchInteractionGraph } from "@/lib/memory/adapters/postgres/interaction-graph-discovery";

export async function listInteractionGraphSnapshot(input: {
  userId: string;
  entityLimit?: number;
  relationLimit?: number;
}): Promise<InteractionGraphSnapshot> {
  const entityLimit = Math.min(
    Math.max(Math.trunc(input.entityLimit ?? 200), 1),
    500,
  );
  const relationLimit = Math.min(
    Math.max(Math.trunc(input.relationLimit ?? 160), 1),
    500,
  );

  const [entityRows, relationRows] = await Promise.all([
    db
      .select()
      .from(memoryGraphEntities)
      .where(
        and(
          eq(memoryGraphEntities.userId, input.userId),
          eq(memoryGraphEntities.scope, GRAPH_SCOPE),
        ),
      )
      .orderBy(desc(memoryGraphEntities.lastSeenAt))
      .limit(entityLimit),
    db
      .select()
      .from(memoryGraphRelations)
      .where(
        and(
          eq(memoryGraphRelations.userId, input.userId),
          eq(memoryGraphRelations.scope, GRAPH_SCOPE),
        ),
      )
      .orderBy(desc(memoryGraphRelations.updatedAt))
      .limit(relationLimit),
  ]);

  const entities = (entityRows as MemoryGraphEntity[]).map((entity) =>
    normalizeEntity(entity),
  );
  const relations = (relationRows as MemoryGraphRelation[]).map((relation) =>
    normalizeRelation(relation),
  );
  const relationIds = relations.map((relation) => relation.id);
  const evidenceRows =
    relationIds.length > 0
      ? await db
          .select()
          .from(memoryGraphEvidence)
          .where(inArray(memoryGraphEvidence.relationId, relationIds))
          .limit(relationLimit * 5)
      : [];
  const evidence = (evidenceRows as MemoryGraphEvidence[]).map((item) =>
    normalizeEvidence(item),
  );

  return {
    entities,
    relations,
    evidence,
    stats: {
      entityCount: entities.length,
      relationCount: relations.length,
      evidenceCount: evidence.length,
      activeRelationCount: relations.filter(
        (relation) => relation.status === "active",
      ).length,
    },
  };
}

export async function clearInteractionGraph(input: {
  userId: string;
  scope?: string;
}) {
  const scope = input.scope ?? GRAPH_SCOPE;
  const relationIdRows = await db
    .select({ id: memoryGraphRelations.id })
    .from(memoryGraphRelations)
    .where(
      and(
        eq(memoryGraphRelations.userId, input.userId),
        eq(memoryGraphRelations.scope, scope),
      ),
    );
  const relationIds = relationIdRows.map((row: { id: string }) => row.id);
  const evidenceRows =
    relationIds.length > 0
      ? await db
          .delete(memoryGraphEvidence)
          .where(
            and(
              eq(memoryGraphEvidence.userId, input.userId),
              inArray(memoryGraphEvidence.relationId, relationIds),
            ),
          )
          .returning({ id: memoryGraphEvidence.id })
      : [];
  const relationRows = await db
    .delete(memoryGraphRelations)
    .where(
      and(
        eq(memoryGraphRelations.userId, input.userId),
        eq(memoryGraphRelations.scope, scope),
      ),
    )
    .returning({ id: memoryGraphRelations.id });
  const entityRows = await db
    .delete(memoryGraphEntities)
    .where(
      and(
        eq(memoryGraphEntities.userId, input.userId),
        eq(memoryGraphEntities.scope, scope),
      ),
    )
    .returning({ id: memoryGraphEntities.id });

  return {
    deletedGraphEvidence: evidenceRows.length,
    deletedGraphRelations: relationRows.length,
    deletedGraphEntities: entityRows.length,
    deletedGraphCount:
      evidenceRows.length + relationRows.length + entityRows.length,
  };
}
