import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { memoryGraphEntities, memoryGraphEvidence, memoryGraphRelations,
  type MemoryGraphEntity, type MemoryGraphEvidence, type MemoryGraphRelation } from "@/lib/db/schema";
import { deserializeJson } from "@/lib/db/serialization";

const GRAPH_SCOPE = "interaction";

export type InteractionGraphSearchResult = {
  relation: MemoryGraphRelation;
  subject: MemoryGraphEntity;
  object: MemoryGraphEntity;
  evidence: MemoryGraphEvidence[];
  score: number;
  content: string;
};

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

function normalizeName(value: string) {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
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

export async function searchInteractionGraph(input: {
  userId: string;
  query: string;
  limit?: number;
}): Promise<InteractionGraphSearchResult[]> {
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 10), 1), 50);
  const query = input.query.trim();
  if (!query) return [];

  const [entities, relations] = await Promise.all([
    db
      .select()
      .from(memoryGraphEntities)
      .where(
        and(
          eq(memoryGraphEntities.userId, input.userId),
          eq(memoryGraphEntities.scope, GRAPH_SCOPE),
        ),
      )
      .limit(500),
    db
      .select()
      .from(memoryGraphRelations)
      .where(
        and(
          eq(memoryGraphRelations.userId, input.userId),
          eq(memoryGraphRelations.scope, GRAPH_SCOPE),
          eq(memoryGraphRelations.status, "active"),
        ),
      )
      .orderBy(desc(memoryGraphRelations.updatedAt))
      .limit(500),
  ]);

  const entityById = new Map(
    (entities as MemoryGraphEntity[]).map((entity) => [
      entity.id,
      normalizeEntity(entity),
    ]),
  );
  const candidateRelations = (relations as MemoryGraphRelation[])
    .map((relation) => normalizeRelation(relation))
    .map((relation) => {
      const subject = entityById.get(relation.subjectEntityId);
      const object = entityById.get(relation.objectEntityId);
      if (!subject || !object) return null;
      const score = Math.max(
        scoreText(query, relation.claim),
        scoreText(query, subject.name),
        scoreText(query, object.name),
        scoreText(query, [
          subject.name,
          object.name,
          relation.relationType,
          relation.claim,
          subject.aliases.join(" "),
          object.aliases.join(" "),
        ].join(" ")),
      );
      return score > 0
        ? {
            relation,
            subject,
            object,
            score: Math.min(
              0.99,
              score + Math.min(relation.confidence, 100) / 1_000,
            ),
          }
        : null;
    })
    .filter(
      (
        item,
      ): item is {
        relation: MemoryGraphRelation;
        subject: MemoryGraphEntity;
        object: MemoryGraphEntity;
        score: number;
      } => Boolean(item),
    )
    .sort((a, b) => {
      const scoreDelta = b.score - a.score;
      if (scoreDelta !== 0) return scoreDelta;
      return (
        new Date(b.relation.updatedAt).getTime() -
        new Date(a.relation.updatedAt).getTime()
      );
    })
    .slice(0, limit);

  if (candidateRelations.length === 0) return [];

  const relationIds = candidateRelations.map((item) => item.relation.id);
  const evidenceRows = await db
    .select()
    .from(memoryGraphEvidence)
    .where(and(eq(memoryGraphEvidence.userId, input.userId), inArray(memoryGraphEvidence.relationId, relationIds)))
    .limit(limit * 10);
  const evidenceByRelation = new Map<string, MemoryGraphEvidence[]>();
  for (const row of evidenceRows as MemoryGraphEvidence[]) {
    const evidence = normalizeEvidence(row);
    const bucket = evidenceByRelation.get(evidence.relationId) ?? [];
    bucket.push(evidence);
    evidenceByRelation.set(evidence.relationId, bucket);
  }

  return candidateRelations.map((item) => {
    const evidence = evidenceByRelation.get(item.relation.id) ?? [];
    return {
      ...item,
      evidence,
      content: relationContent({ ...item, evidence }),
    };
  });
}

