import { sql } from "drizzle-orm";
import {
  parseAgentRuntimeRunSnapshot,
  type AgentRuntimeRunSnapshot,
} from "@/lib/ai/runtime/run-snapshot";
import type { DrizzleDB } from "@/lib/db/types";

export type WorkRunRuntimeSnapshotRef = {
  eventId: string;
  createdAt: string;
  runId: string | null;
  loopId: string | null;
  loopRunId: string | null;
  snapshot: AgentRuntimeRunSnapshot;
};

export type WorkRunRuntimeSnapshotAuditSummary = {
  eventId: string;
  createdAt: string;
  runId: string | null;
  loopId: string | null;
  loopRunId: string | null;
  engine: string;
  adapter: string;
  model: string;
  modelTier: string;
  runtimeHash: string;
  policyHash: string;
  allowedToolCount: number;
};

export type PersistWorkRunRuntimeSnapshotInput = {
  workshopId: string;
  runId: string;
  eventId?: string | null;
  loopId?: string | null;
  loopRunId?: string | null;
  snapshot: AgentRuntimeRunSnapshot;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export function parseWorkRunReviewRuntimeSnapshot(
  value: unknown,
): WorkRunRuntimeSnapshotRef | null {
  const row = record(value);
  const snapshot = parseAgentRuntimeRunSnapshot(row.snapshot);
  const eventId = text(row.eventId);
  const createdAt = text(row.createdAt);
  if (!eventId || !createdAt || !snapshot) return null;
  return {
    eventId,
    createdAt,
    runId: text(row.runId),
    loopId: text(row.loopId),
    loopRunId: text(row.loopRunId),
    snapshot,
  };
}

export function summarizeWorkRunReviewRuntimeSnapshot(
  value: WorkRunRuntimeSnapshotRef | null,
): WorkRunRuntimeSnapshotAuditSummary | null {
  if (!value) return null;
  return {
    eventId: value.eventId,
    createdAt: value.createdAt,
    runId: value.runId,
    loopId: value.loopId,
    loopRunId: value.loopRunId,
    engine: value.snapshot.engine,
    adapter: value.snapshot.adapter,
    model: value.snapshot.model,
    modelTier: value.snapshot.modelTier,
    runtimeHash: value.snapshot.runtimeHash,
    policyHash: value.snapshot.policyHash,
    allowedToolCount: value.snapshot.allowedToolCount,
  };
}

export async function persistWorkRunRuntimeSnapshot(
  db: Pick<DrizzleDB, "execute">,
  input: PersistWorkRunRuntimeSnapshotInput,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO workshop_runtime_snapshots(
      workshop_id,
      run_id,
      event_id,
      loop_id,
      loop_run_id,
      engine,
      adapter,
      model,
      model_tier,
      runtime_hash,
      policy_hash,
      allowed_tool_count,
      snapshot_json
    ) VALUES (
      ${input.workshopId}::uuid,
      ${input.runId}::uuid,
      ${input.eventId ?? null}::uuid,
      ${input.loopId ?? null}::uuid,
      ${input.loopRunId ?? null}::uuid,
      ${input.snapshot.engine},
      ${input.snapshot.adapter},
      ${input.snapshot.model},
      ${input.snapshot.modelTier},
      ${input.snapshot.runtimeHash},
      ${input.snapshot.policyHash},
      ${input.snapshot.allowedToolCount},
      ${JSON.stringify(input.snapshot)}::jsonb
    )
    ON CONFLICT (event_id) WHERE event_id IS NOT NULL DO UPDATE SET
      engine=EXCLUDED.engine,
      adapter=EXCLUDED.adapter,
      model=EXCLUDED.model,
      model_tier=EXCLUDED.model_tier,
      runtime_hash=EXCLUDED.runtime_hash,
      policy_hash=EXCLUDED.policy_hash,
      allowed_tool_count=EXCLUDED.allowed_tool_count,
      snapshot_json=EXCLUDED.snapshot_json
  `);
}

export async function readWorkRunRuntimeSnapshotSummary(
  db: Pick<DrizzleDB, "execute">,
  input: { workId: string; runId: string },
): Promise<WorkRunRuntimeSnapshotAuditSummary | null> {
  const projectionTable = await db.execute(sql`
    SELECT to_regclass('public.workshop_runtime_snapshots') AS table_name
  `);
  if (projectionTable[0]?.table_name) {
    const persistedRows = await db.execute(sql`
      SELECT jsonb_build_object(
        'eventId', COALESCE(s.event_id::text, s.id::text),
        'createdAt', s.created_at,
        'runId', s.run_id,
        'loopId', s.loop_id,
        'loopRunId', s.loop_run_id,
        'snapshot', s.snapshot_json
      ) AS runtime_snapshot
      FROM workshop_runtime_snapshots s
      WHERE s.workshop_id=${input.workId}::uuid
        AND s.run_id=${input.runId}::uuid
      ORDER BY s.created_at DESC, s.id DESC
      LIMIT 1
    `);
    const persisted = summarizeWorkRunReviewRuntimeSnapshot(
      parseWorkRunReviewRuntimeSnapshot(persistedRows[0]?.runtime_snapshot),
    );
    if (persisted) return persisted;
  }

  // Compatibility path for databases that have not applied the projection
  // table migration yet. The original event remains the source of truth.
  const rows = await db.execute(sql`
    SELECT jsonb_build_object(
      'eventId', e.id,
      'createdAt', e.created_at,
      'runId', e.run_id,
      'loopId', e.loop_id,
      'loopRunId', e.loop_run_id,
      'snapshot', e.metadata->'runtimeRunSnapshot'
    ) AS runtime_snapshot
    FROM workshop_events e
    WHERE e.workshop_id=${input.workId}::uuid
      AND e.run_id=${input.runId}::uuid
      AND e.type='agent_configured'
    ORDER BY e.seq DESC
    LIMIT 1
  `);
  return summarizeWorkRunReviewRuntimeSnapshot(
    parseWorkRunReviewRuntimeSnapshot(rows[0]?.runtime_snapshot),
  );
}

function isRuntimeSnapshotAuditSummary(
  value: unknown,
): value is WorkRunRuntimeSnapshotAuditSummary {
  const item = record(value);
  return Boolean(
    text(item.eventId) &&
      text(item.createdAt) &&
      text(item.engine) &&
      text(item.adapter) &&
      text(item.model) &&
      text(item.modelTier) &&
      text(item.runtimeHash) &&
      text(item.policyHash) &&
      typeof item.allowedToolCount === "number" &&
      Number.isFinite(item.allowedToolCount),
  );
}

export function extractWorkRunRuntimeSnapshotSummary(
  value: unknown,
): WorkRunRuntimeSnapshotAuditSummary | null {
  if (isRuntimeSnapshotAuditSummary(value)) return value;
  const root = record(value);
  const candidates = [
    root.runtimeSnapshot,
    record(root.metadata).runtimeSnapshot,
    record(root.request).runtimeSnapshot,
    record(record(root.request).metadata).runtimeSnapshot,
    record(root.result).runtimeSnapshot,
    record(root.resolution).runtimeSnapshot,
    record(record(root.resolution).priorCompletion).runtimeSnapshot,
    record(record(record(root.resolution).priorCompletion).request).runtimeSnapshot,
    record(record(record(record(root.resolution).priorCompletion).request).metadata)
      .runtimeSnapshot,
    record(record(record(root.resolution).priorCompletion).result).runtimeSnapshot,
    record(record(record(root.resolution).priorCompletion).resolution).runtimeSnapshot,
    record(root.priorCompletion).runtimeSnapshot,
    record(record(root.priorCompletion).request).runtimeSnapshot,
    record(record(record(root.priorCompletion).request).metadata).runtimeSnapshot,
    record(record(root.priorCompletion).result).runtimeSnapshot,
    record(record(root.priorCompletion).resolution).runtimeSnapshot,
  ];
  for (const candidate of candidates) {
    if (isRuntimeSnapshotAuditSummary(candidate)) return candidate;
  }
  return null;
}

export function compareWorkRunRuntimeSnapshotSummaries(
  current: WorkRunRuntimeSnapshotAuditSummary | null,
  receipt: WorkRunRuntimeSnapshotAuditSummary | null,
): { matches: boolean; reason: string | null } | null {
  if (!current || !receipt) return null;
  if (current.runtimeHash !== receipt.runtimeHash) {
    return { matches: false, reason: "runtime_hash_mismatch" };
  }
  if (current.policyHash !== receipt.policyHash) {
    return { matches: false, reason: "policy_hash_mismatch" };
  }
  if (current.engine !== receipt.engine || current.model !== receipt.model) {
    return { matches: false, reason: "runtime_identity_mismatch" };
  }
  return { matches: true, reason: null };
}
