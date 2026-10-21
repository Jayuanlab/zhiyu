import { eq, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { user } from "@/lib/db/schema";
import type { InteractionEvent, InteractionMemory, InteractionNote, InteractionTask } from "@/lib/db/schema";
import { shouldPreferBrainMemory, shouldReadLegacyMemoryFallback } from "@/lib/memory/retrieval/mode";

type Page<T> = { total: number; items: T[]; returned: number; hasMore: boolean; cursor: string | null };
type RawPage = {total: number; items: Record<string, unknown>[]};

function camelRow<T>(row: Record<string, unknown>): T {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => {
    const name = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
    return [name, /(?:At|Time)$/.test(name) && typeof value === "string" ? new Date(value) : value];
  })) as T;
}

function page<T>(value: RawPage, offset: number): Page<T> {
  const items = value.items.map(item => camelRow<T>(item));
  const total = Number(value.total);
  const hasMore = offset + items.length < total;
  return {total, items, returned: items.length, hasMore, cursor: hasMore ? String(offset + items.length) : null};
}

/** Count and paginate after ownership, source authorization and category filtering, in one statement. */
export async function readWechatDigestProjection(input: {
  userId: string; allowedConversationIds: string[] | null; since?: Date; limit: number; offset?: number;
}) {
  const offset = Math.max(0, Math.trunc(input.offset ?? 0));
  const allowed = input.allowedConversationIds;
  const eventScope = allowed === null ? sql`true` : sql`e.conversation_id in (select jsonb_array_elements_text(${JSON.stringify(allowed)}::jsonb))`;
  const itemScope = (alias: string, evidence: string): SQL => {
    if (allowed === null) return sql`true`;
    const refs = sql.raw(`${alias}.${evidence}`);
    const conversations = sql.raw(`${alias}.metadata->'conversationIds'`);
    // Aggregated content is denied when any declared conversation is outside the scope.
    return sql`(
      (jsonb_array_length(coalesce(${conversations}, '[]'::jsonb)) > 0
        and not exists (select 1 from jsonb_array_elements_text(${conversations}) c
          where c not in (select jsonb_array_elements_text(${JSON.stringify(allowed)}::jsonb))))
      or (jsonb_array_length(${refs}) > 0 and not exists (
        select 1 from jsonb_array_elements_text(${refs}) r
        where not exists (select 1 from scoped_events e where e.id::text = r)
      ))
    ) and not exists (select 1 from jsonb_array_elements_text(coalesce(${conversations}, '[]'::jsonb)) c
      where c not in (select jsonb_array_elements_text(${JSON.stringify(allowed)}::jsonb)))
      and not exists (select 1 from jsonb_array_elements_text(${refs}) r
        where not exists (select 1 from scoped_events e where e.id::text = r))`;
  };
  const group = (name: string, order: string) => sql`jsonb_build_object(
    'total', (select count(*) from ${sql.raw(name)}),
    'items', coalesce((select jsonb_agg(to_jsonb(p)) from
      (select * from ${sql.raw(name)} order by ${sql.raw(order)} limit ${input.limit} offset ${offset}) p), '[]'::jsonb))`;
  const preferBrain = shouldPreferBrainMemory();
  const legacy = shouldReadLegacyMemoryFallback();
  const [result] = await db.select({payload: sql<{
    asOf: string; lastSourceObservedAt: string | null; lastSourceCollectedAt: string | null;
    tasks: RawPage; risks: RawPage; replies: RawPage; memories: RawPage;
  }>`(with scoped_events as (
      select e.* from interaction_events e where e.user_id = ${input.userId} and e.platform = 'wechat' and ${eventScope}
    ), tasks as (
      select t.*, (select min(e.message_time) from scoped_events e where e.id = t.event_id or t.source_event_ids ? e.id::text) as source_observed_at
      from interaction_tasks t where t.user_id = ${input.userId}
        and t.status not in ('done','dismissed','deleted') and ${itemScope("t", "source_event_ids")}
    ), risks as (
      select n.* from interaction_notes n where n.user_id = ${input.userId}
        and not (n.metadata ? 'deletedAt') and not (n.metadata ? 'dismissedAt')
        and (n.note_type in ('risk','reply_need') or n.metadata->>'riskLevel' in ('medium','high'))
        and ${itemScope("n", "source_event_ids")}
    ), replies as (
      select e.* from scoped_events e where (e.requires_reply = true or e.importance = 'high')
        and (${input.since?.toISOString() ?? null}::timestamptz is null or e.message_time >= ${input.since?.toISOString() ?? null}::timestamptz)
        and e.processed_status != 'ignored'
    ), canonical as (
      select b.id, b.user_id, b.memory_type, b.subject, b.content, b.status, b.confidence, b.tags,
        b.evidence_refs as source_event_ids, b.metadata, b.created_at, b.updated_at, b.expires_at
      from brain_memories b where ${preferBrain} and b.user_id = ${input.userId}
        and b.owner_type = 'chat' and b.owner_id = ${input.userId} and b.status = 'candidate'
        and ${itemScope("b", "evidence_refs")}
    ), memories as (
      select * from canonical union all
      select m.id, m.user_id, m.memory_type, m.subject, m.content, m.status, m.confidence, m.tags,
        m.source_event_ids, m.metadata, m.created_at, m.updated_at, m.expires_at
      from interaction_memories m where ${legacy} and m.user_id = ${input.userId} and m.status = 'candidate'
        and not exists (select 1 from canonical) and ${itemScope("m", "source_event_ids")}
    ) select jsonb_build_object('asOf', statement_timestamp(),
      'lastSourceObservedAt', (select max(message_time) from scoped_events),
      'lastSourceCollectedAt', (select max(collected_at) from scoped_events),
      'tasks', ${group("tasks", "case when metadata->'taskState'->>'dueAtConfidence' = 'confirmed' and due_at < statement_timestamp() then 0 else 1 end, due_at asc nulls last, created_at asc, id asc")},
      'risks', ${group("risks", "case when metadata->>'riskLevel' = 'high' then 0 else 1 end, created_at desc, id asc")},
      'replies', ${group("replies", "message_time desc, id asc")},
      'memories', ${group("memories", "created_at desc, id asc")}
    ))`}).from(user).where(eq(user.id, input.userId)).limit(1);
  if (!result) throw new Error("Digest owner is unavailable");
  const value = result.payload;
  return {asOf: value.asOf, lastSourceObservedAt: value.lastSourceObservedAt,
    lastSourceCollectedAt: value.lastSourceCollectedAt,
    tasks: page<InteractionTask & {sourceObservedAt: Date | null}>(value.tasks, offset),
    risks: page<InteractionNote>(value.risks, offset), replies: page<InteractionEvent>(value.replies, offset),
    memories: page<InteractionMemory>(value.memories, offset)};
}
