import { sql } from 'drizzle-orm';
import type { DrizzleDB } from '@/lib/db/types';
import { ExecutionLeaseError } from './execution-errors';

export type ExecutionLease = { userId: string; workshopId: string; runId: string; workerId: string; token: number };
export type ExecutionLeaseTarget = Pick<ExecutionLease, 'userId' | 'workshopId'>;
export type ExecutionLeaseRow = {
  token: number; run_id: string | null; worker_id: string | null; phase: string;
  lease_until: Date | null; effect_started: boolean; result_json: unknown; expired: boolean;
};
export type ExecutionFenceContext = { db: Pick<DrizzleDB, 'execute'> };

/** Transaction and async-scope ownership belong to the trusted host adapter.
 * This fence neither grants resource access nor performs business dependency checks. */
export type ExecutionFencePorts<C extends ExecutionFenceContext> = {
  currentContext(lease: ExecutionLease): C | undefined;
  transaction<T>(work: (context: C) => Promise<T>): Promise<T>;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertExecutionTarget(target: ExecutionLeaseTarget) {
  if (!uuid.test(target.userId) || !uuid.test(target.workshopId)) throw new ExecutionLeaseError('invalid_lease');
}

export async function lockExecutionTarget(tx: ExecutionFenceContext['db'], target: ExecutionLeaseTarget) {
  assertExecutionTarget(target);
  const rows = await tx.execute(sql`SELECT status FROM workshops WHERE id=${target.workshopId}::uuid AND user_id=${target.userId}::uuid FOR UPDATE`);
  if (!rows[0]) throw new ExecutionLeaseError('not_found');
  return rows[0];
}

export async function readExecutionLeaseForUpdate(tx: ExecutionFenceContext['db'], target: ExecutionLeaseTarget): Promise<ExecutionLeaseRow | null> {
  const rows = await tx.execute(sql`SELECT *,lease_until<=clock_timestamp() AS expired FROM workshop_execution_leases WHERE workshop_id=${target.workshopId}::uuid FOR UPDATE`);
  return rows[0] as ExecutionLeaseRow ?? null;
}

export async function readExecutionRunForUpdate(tx: ExecutionFenceContext['db'], target: ExecutionLeaseTarget, runId: string) {
  if (!uuid.test(runId)) throw new ExecutionLeaseError('invalid_lease');
  const rows = await tx.execute(sql`SELECT * FROM workshop_runs WHERE id=${runId}::uuid AND workshop_id=${target.workshopId}::uuid FOR UPDATE`);
  if (!rows[0]) throw new ExecutionLeaseError('not_found');
  return rows[0];
}

/** The callback is database-only and must remain inside the supplied transaction.
 * Lock ownership first, then verify the token/run and DB time before and after work.
 * Propagate errors so the host rolls back both records and their audit events. */
export async function withExecutionFenceTransaction<C extends ExecutionFenceContext, T>(
  lease: ExecutionLease, context: C, write: (context: C) => Promise<T>,
): Promise<T> {
  const tx = context.db;
  await lockExecutionTarget(tx, lease);
  const current = await readExecutionLeaseForUpdate(tx, lease);
  const ownedRun = await readExecutionRunForUpdate(tx, lease, lease.runId);
  if (!current || current.token !== lease.token || current.run_id !== lease.runId || current.worker_id !== lease.workerId ||
    current.phase !== 'running' || current.expired || ownedRun.status !== 'running') throw new ExecutionLeaseError('lease_lost');
  const result = await write(context);
  const time = await tx.execute(sql`SELECT clock_timestamp()<${current.lease_until}::timestamptz AS valid`);
  if (!time[0]?.valid) throw new ExecutionLeaseError('lease_lost');
  return result;
}

/** Reuse an active host-owned transaction; otherwise obtain one from its adapter.
 * No model, network call, domain handler or async-context implementation is loaded here. */
export async function withExecutionFence<C extends ExecutionFenceContext, T>(
  lease: ExecutionLease, write: (context: C) => Promise<T>, ports: ExecutionFencePorts<C>,
): Promise<T> {
  const existing = ports.currentContext(lease);
  if (existing) return withExecutionFenceTransaction(lease, existing, write);
  return ports.transaction(context => withExecutionFenceTransaction(lease, context, write));
}
