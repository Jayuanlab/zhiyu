import { sql } from "drizzle-orm";
import type { DrizzleDB } from "@/lib/db/types";
import { parseWorkRunReviewRuntimeSnapshot, summarizeWorkRunReviewRuntimeSnapshot, type PersistWorkRunRuntimeSnapshotInput, type WorkRunRuntimeSnapshotAuditSummary } from "../../records/runtime-snapshots";
import { MemoryIdentityConflict } from "../../kernel/reference-errors";

export async function readBusinessCheckpointRuntimeRows(store: Pick<DrizzleDB, "execute">, input: {
  workshopId: string; runId: string; loopId: string; loopRunId: string;
}) {
  return store.execute(sql`SELECT snapshot_json FROM workshop_runtime_snapshots
    WHERE workshop_id=${input.workshopId}::uuid AND run_id=${input.runId}::uuid
      AND loop_id=${input.loopId}::uuid AND loop_run_id=${input.loopRunId}::uuid LIMIT 17`);
}

export async function persistWorkRunRuntimeSnapshot(
  db: Pick<DrizzleDB, "execute">,
  input: PersistWorkRunRuntimeSnapshotInput,
): Promise<void> {
  const rows = await db.execute(sql`
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
    ON CONFLICT (event_id) WHERE event_id IS NOT NULL DO UPDATE SET event_id=EXCLUDED.event_id
    WHERE workshop_runtime_snapshots.workshop_id=EXCLUDED.workshop_id
      AND workshop_runtime_snapshots.run_id=EXCLUDED.run_id
      AND workshop_runtime_snapshots.loop_id IS NOT DISTINCT FROM EXCLUDED.loop_id
      AND workshop_runtime_snapshots.loop_run_id IS NOT DISTINCT FROM EXCLUDED.loop_run_id
      AND workshop_runtime_snapshots.engine=EXCLUDED.engine
      AND workshop_runtime_snapshots.adapter=EXCLUDED.adapter
      AND workshop_runtime_snapshots.model=EXCLUDED.model
      AND workshop_runtime_snapshots.model_tier=EXCLUDED.model_tier
      AND workshop_runtime_snapshots.runtime_hash=EXCLUDED.runtime_hash
      AND workshop_runtime_snapshots.policy_hash=EXCLUDED.policy_hash
      AND workshop_runtime_snapshots.allowed_tool_count=EXCLUDED.allowed_tool_count
      AND workshop_runtime_snapshots.snapshot_json=EXCLUDED.snapshot_json
    RETURNING id
  `);
  if (!rows.length) throw new MemoryIdentityConflict();
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
