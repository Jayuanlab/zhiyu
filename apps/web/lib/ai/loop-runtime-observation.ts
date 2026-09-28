import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const maximumHeartbeatAgeMs = 120_000;

type RuntimeRow = {
  run_id: string;
  loop_run_id: string;
  work_run_status: string;
  lease_run_id: string | null;
  lease_phase: string | null;
  lease_until: Date | string | null;
  heartbeat_at: Date | string | null;
};
type LoopConfig = { status: string; updatedAt: Date | string };
type Readers = {
  ownsLoop: (userId: string, loopId: string) => Promise<boolean>;
  readActiveExecution: (userId: string, loopId: string) => Promise<{
    observedAt: Date | string; row: RuntimeRow | null; stillOwned?: boolean; loopConfig?: LoopConfig | null;
  }>;
};

const readers: Readers = {
  async ownsLoop(userId, loopId) {
    const rows = await db.execute(sql`SELECT 1 FROM loops WHERE id=${loopId}::uuid AND user_id=${userId}::uuid LIMIT 1`);
    return rows.length > 0;
  },
  async readActiveExecution(userId, loopId) {
    // DB time and evidence are read in one statement. The owner predicate is
    // repeated because ownership may change between the two statements.
    const rows = await db.execute(sql`SELECT clock_timestamp() AS observed_at,
      p.status AS loop_status, p.updated_at AS loop_updated_at,
      x.run_id, x.loop_run_id, r.status AS work_run_status,
      l.run_id AS lease_run_id, l.phase AS lease_phase,
      l.lease_until, l.heartbeat_at
      FROM loops p JOIN workshop_loop_executions x ON x.loop_id=p.id AND x.active
      JOIN workshop_runs r ON r.id=x.run_id AND r.workshop_id=x.workshop_id
      LEFT JOIN workshop_execution_leases l ON l.workshop_id=x.workshop_id
      WHERE p.id=${loopId}::uuid AND p.user_id=${userId}::uuid LIMIT 1`);
    if (rows[0]) {
      const { observed_at, loop_status, loop_updated_at, ...row } = rows[0] as typeof rows[number] & {
        observed_at: Date | string; loop_status: string; loop_updated_at: Date | string;
      };
      return { observedAt: observed_at, row: row as RuntimeRow,
        loopConfig: { status: loop_status, updatedAt: loop_updated_at } };
    }
    const clock = await db.execute(sql`SELECT clock_timestamp() AS observed_at,
      (SELECT status FROM loops WHERE id=${loopId}::uuid AND user_id=${userId}::uuid) AS loop_status,
      (SELECT updated_at FROM loops WHERE id=${loopId}::uuid AND user_id=${userId}::uuid) AS loop_updated_at`);
    const stillOwned = clock[0].loop_status !== null;
    return { observedAt: clock[0].observed_at as Date | string, row: null,
      stillOwned, loopConfig: stillOwned ? { status: String(clock[0].loop_status),
        updatedAt: clock[0].loop_updated_at as Date | string } : null };
  },
};

function iso(value: Date | string | null | undefined) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** A bounded observation of the fenced Work executor linked to one owner Loop. */
export async function readLoopRuntimeObservationForOwner(
  input: { userId: string; loopId: string }, source: Readers = readers,
) {
  if (!uuid.test(input.userId) || !uuid.test(input.loopId)) throw Error("Invalid owner or Loop ID");
  if (!await source.ownsLoop(input.userId, input.loopId)) return {
    status: "loop_not_found_in_scope" as const, provider: "workshop_execution_leases" as const,
    warning: "No owner-visible Loop; execution state was not read.",
  };
  const { observedAt, row, stillOwned, loopConfig } = await source.readActiveExecution(input.userId, input.loopId);
  if (stillOwned === false) return { status: "loop_not_found_in_scope" as const,
    provider: "workshop_execution_leases" as const,
    warning: "Loop ownership changed during the read; execution state was not returned." };
  const observedAtIso = iso(observedAt);
  if (!observedAtIso) throw Error("Invalid database observation time");
  const observedMs = Date.parse(observedAtIso);
  const heartbeatAt = iso(row?.heartbeat_at);
  const leaseUntil = iso(row?.lease_until);
  const heartbeatAgeMs = heartbeatAt ? observedMs - Date.parse(heartbeatAt) : null;
  const sameRun = Boolean(row && row.lease_run_id === row.run_id);
  const freshHeartbeat = heartbeatAgeMs !== null && heartbeatAgeMs >= 0 && heartbeatAgeMs <= maximumHeartbeatAgeMs;
  const unexpiredLease = leaseUntil !== null && Date.parse(leaseUntil) > observedMs;
  const status = !row ? "no_active_linked_execution_observed"
    : row.lease_phase === "running" && row.work_run_status === "running" && sameRun && freshHeartbeat && unexpiredLease
      ? "active_lease_recent_heartbeat" : "not_currently_verified";
  return {
    status, provider: "workshop_execution_leases" as const, loopId: input.loopId,
    observedAt: observedAtIso, maximumHeartbeatAgeMs,
    observationScope: row ? "linked_execution_and_matching_lease" : "active_linked_execution_mapping_only",
    loopConfiguration: loopConfig ? { status: loopConfig.status, updatedAt: iso(loopConfig.updatedAt),
      temporalScope: "configuration_at_database_read_time_not_executor_activity" } : null,
    linkedExecution: row ? { workRunId: row.run_id, loopRunId: row.loop_run_id,
      workRunStatus: row.work_run_status, leasePhase: row.lease_phase,
      leaseMatchesRun: sameRun, leaseUntil, heartbeatAt, heartbeatAgeMs,
      heartbeatFresh: freshHeartbeat, leaseUnexpired: unexpiredLease } : null,
    warning: status === "active_lease_recent_heartbeat"
      ? "A matching fenced lease and recent heartbeat were observed at database read time. This does not prove that the process is alive at the instant of the answer or that the Loop outcome succeeded."
      : status === "no_active_linked_execution_observed"
        ? "No active linked execution mapping was observed at database read time, so no lease or heartbeat for this Loop was evaluated. Describe only the missing mapping; lease and heartbeat have no observed value in this result. This does not prove the process stopped or establish current process liveness, inactivity, scheduling, or cause. Do not infer that the executor is likely stopped or stalled from an older persisted error."
        : "No currently verifiable executor was observed for this Loop. This does not establish current process liveness, inactivity, scheduling, or cause; check the persisted run and scheduler separately.",
  };
}
