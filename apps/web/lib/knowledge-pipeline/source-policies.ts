import { and, desc, eq, sql } from 'drizzle-orm';
import { db, withDatabaseTransaction } from '@/lib/db/client';
import {isTauriMode} from '@/lib/env/constants';
import { interactionSourcePolicies } from '@/lib/db/schema';
import { deserializeJson, serializeJson } from '@/lib/db/serialization';

export type InteractionSourcePolicyValue =
  | 'sync'
  | 'summary'
  | 'mention_only'
  | 'ignore';

export type InteractionSourcePolicyView = {
  id: string;
  userId: string;
  platform: string;
  sourceId: string;
  sourceName: string;
  sourceType: string;
  policy: InteractionSourcePolicyValue;
  enabled: boolean;
  priority: number;
  lastSeenAt: Date | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
};

export type SourcePolicyInput = {
  userId: string;
  platform: string;
  sourceId: string;
  sourceName: string;
  sourceType?: string;
  policy: InteractionSourcePolicyValue;
  enabled?: boolean;
  priority?: number;
  lastSeenAt?: Date | null;
  metadata?: Record<string, unknown>;
};

const allowedPolicies = new Set<InteractionSourcePolicyValue>([
  'sync',
  'summary',
  'mention_only',
  'ignore',
]);

export function normalizeSourcePolicy(value: unknown): InteractionSourcePolicyValue {
  const policy = String(value ?? '').trim() as InteractionSourcePolicyValue;
  return allowedPolicies.has(policy) ? policy : 'sync';
}

function parseMetadata(value: unknown): Record<string, unknown> {
  const parsed = deserializeJson(value as any);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function normalizePolicy(row: any): InteractionSourcePolicyView {
  return {
    ...row,
    policy: normalizeSourcePolicy(row.policy),
    metadata: parseMetadata(row.metadata),
  };
}

function toDbMetadata(value: Record<string, unknown> | undefined) {
  return serializeJson(value ?? {}) as Record<string, unknown>;
}

export async function listInteractionSourcePolicies(input: {
  userId: string;
  platform?: string;
}): Promise<InteractionSourcePolicyView[]> {
  const conditions = [eq(interactionSourcePolicies.userId, input.userId)];
  if (input.platform) {
    conditions.push(eq(interactionSourcePolicies.platform, input.platform));
  }

  const rows = (await db
    .select()
    .from(interactionSourcePolicies)
    .where(and(...conditions))
    .orderBy(desc(interactionSourcePolicies.updatedAt))) as any[];
  return rows.map(normalizePolicy);
}

export async function upsertInteractionSourcePolicy(
  input: SourcePolicyInput,
): Promise<InteractionSourcePolicyView> {
  return withDatabaseTransaction(async()=>{
  await lockInteractionSourcePolicies(input.userId);
  const now = new Date();
  const [row] = (await db
    .insert(interactionSourcePolicies)
    .values({
      userId: input.userId,
      platform: input.platform,
      sourceId: input.sourceId,
      sourceName: input.sourceName,
      sourceType: input.sourceType ?? 'unknown',
      policy: normalizeSourcePolicy(input.policy),
      enabled: input.enabled ?? true,
      priority: input.priority ?? 0,
      lastSeenAt: input.lastSeenAt ?? null,
      metadata: toDbMetadata(input.metadata),
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        interactionSourcePolicies.userId,
        interactionSourcePolicies.platform,
        interactionSourcePolicies.sourceId,
      ],
      set: {
        sourceName: input.sourceName,
        sourceType: input.sourceType ?? 'unknown',
        policy: normalizeSourcePolicy(input.policy),
        enabled: input.enabled ?? true,
        priority: input.priority ?? 0,
        lastSeenAt: input.lastSeenAt ?? null,
        metadata: toDbMetadata(input.metadata),
        updatedAt: now,
      },
    })
    .returning()) as any[];
  return normalizePolicy(row);
  });
}

/** Caller must hold a transaction; serialize policy changes with derived writes for this owner. */
export async function lockInteractionSourcePolicies(userId:string){
  if(!isTauriMode())await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'interaction-source-policy:'+userId.toLowerCase()},0))`);
}
