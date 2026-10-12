import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { withWorkshopEventTransaction } from "@/lib/workshops/event-write";
import { canonicalCommandJson, commandPayloadHash, type CommandJson } from "./command-payload";
import {appendWorkCommandAudit} from "./command-audit";
import {withExecutionBusinessTransaction, ExecutionLeaseError, type ExecutionLease} from "./execution-lease";
import {resolveExecutionLease} from "./execution-context";

const WORK_COMMAND_CONFLICT_CODES = ["payload_conflict", "version_conflict", "manifest_conflict", "manifest_identity_reserved", "ambiguous_target", "WORK_VERSION_STALE", "invalid_proposal", "proposal_already_resolved", "not_found", "invalid_command", "target_busy", "unresolved_effect", "loop_migration_required", "input_not_available"] as const;
export type WorkCommandConflictCode = typeof WORK_COMMAND_CONFLICT_CODES[number];
export class WorkCommandConflict extends Error {
  constructor(public readonly code: WorkCommandConflictCode) { super(code); }
  get status() { return this.code === "not_found" ? 404 : this.code === "invalid_command" ? 400 : 409; }
}
export function throwWorkCommandFailure(errorCode: string | null): never {
  if (WORK_COMMAND_CONFLICT_CODES.includes(errorCode as WorkCommandConflictCode)) throw new WorkCommandConflict(errorCode as WorkCommandConflictCode);
  throw new Error(`Work command failed: ${errorCode ?? "unknown_failure"}`);
}
export interface LocalWorkCommand {
  ownerId: string;
  commandId: string;
  workId: string;
  type: string;
  expectedVersion: number;
  payload: CommandJson;
}
export interface WorkCommandRecord {
  commandId: string;
  workId: string;
  type: string;
  payloadHash: string;
  payload: CommandJson;
  expectedVersion: number;
  status: "queued" | "succeeded" | "failed";
  result: CommandJson;
  errorCode: string | null;
  createdAt: Date;
  completedAt: Date | null;
  preparedPayload: CommandJson | null;
  preparedAt: Date | null;
  preparationError: string | null;
}
function record(row: Record<string, any>): WorkCommandRecord {
  return {commandId: row.command_id, workId: row.target_id, type: row.type, payloadHash: row.payload_hash,
    payload: row.payload, expectedVersion: row.expected_version, status: row.status, result: row.result,
    errorCode: row.error_code, createdAt: row.created_at, completedAt: row.completed_at,
    preparedPayload: row.prepared_payload ?? null, preparedAt: row.prepared_at ?? null, preparationError: row.preparation_error ?? null};
}

/** Read-only model preparation runs outside transactions. First saved draft wins;
 * a concurrent planner cannot replace it or apply a different draft. */
export async function prepareLocalWorkCommand(ownerId: string, commandId: string,
  prepare: (payload: CommandJson) => Promise<CommandJson>,
): Promise<WorkCommandRecord> {
  const existing = await getWorkCommand(ownerId, commandId);
  if (!existing) throw new WorkCommandConflict("not_found");
  if (existing.status !== "queued" || existing.preparedPayload !== null) return existing;
  try {
    const prepared = canonicalCommandJson(await prepare(existing.payload));
    await db.execute(sql`UPDATE work_commands SET prepared_payload=${prepared}::jsonb,prepared_at=now(),preparation_error=NULL
      WHERE owner_id=${ownerId}::uuid AND command_id=${commandId} AND status='queued' AND prepared_payload IS NULL`);
  } catch (error) {
    if (error instanceof WorkCommandConflict) {
      return withWorkshopEventTransaction(async (tx, append) => {
        const rows = await tx.execute(sql`SELECT * FROM work_commands WHERE owner_id=${ownerId}::uuid AND command_id=${commandId} FOR UPDATE`);
        const row = rows[0];
        if (!row) throw new WorkCommandConflict("not_found");
        // A concurrent preparer may already have committed the winning draft.
        if (row.status !== "queued" || row.prepared_payload !== null) return record(row);
        const owned = await tx.execute(sql`SELECT id FROM workshops WHERE id=${row.target_id}::uuid AND user_id=${ownerId}::uuid FOR UPDATE`);
        const failed = await tx.execute(sql`UPDATE work_commands SET status='failed',error_code=${error.code},completed_at=now(),preparation_error=${error.code}
          WHERE owner_id=${ownerId}::uuid AND command_id=${commandId} RETURNING *`);
        await appendWorkCommandAudit(tx, {ownerId,commandId,workId:row.target_id,phase:"failed",metadata:{errorCode:error.code,phase:"preparation"}});
        if (owned[0]) await append({workshopId:row.target_id,type:"work_command_failed",title:"Work command preparation rejected",metadata:{commandId,errorCode:error.code}});
        return record(failed[0]);
      });
    }
    await db.execute(sql`UPDATE work_commands SET preparation_error='preparation_failed'
      WHERE owner_id=${ownerId}::uuid AND command_id=${commandId} AND status='queued' AND prepared_payload IS NULL`);
    throw error;
  }
  const saved = await getWorkCommand(ownerId, commandId);
  if (!saved) throw new WorkCommandConflict("not_found");
  return saved;
}
function normalize(input: LocalWorkCommand) {
  if (typeof input.commandId !== "string" || !input.commandId.trim() || input.commandId.length > 256 || typeof input.type !== "string" || !input.type.trim() || input.type.length > 100) throw new WorkCommandConflict("invalid_command");
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0 || input.expectedVersion >= 2147483647) throw new WorkCommandConflict("invalid_command");
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuid.test(input.workId) || !uuid.test(input.ownerId)) throw new WorkCommandConflict("invalid_command");
  const command = {...input, payload: JSON.parse(canonicalCommandJson(input.payload)) as CommandJson,
    ownerId: input.ownerId.toLowerCase(), workId: input.workId.toLowerCase()};
  const hash = commandPayloadHash({contract: "local-work-command.v1", target: command.workId, type: command.type,
    expectedVersion: command.expectedVersion, payload: command.payload});
  return {command, hash};
}

/** Persist acceptance before execution. A crash leaves a queryable queued command.
 * Only trusted server code supplies ownerId; this is not an HTTP auth boundary.
 */
export async function acceptLocalWorkCommand(input: LocalWorkCommand): Promise<WorkCommandRecord> {
  const {command: c, hash} = normalize(input);
  return withWorkshopEventTransaction(async (tx, append) => {
    const owner = await tx.execute(sql`SELECT id FROM workshops WHERE id=${c.workId}::uuid AND user_id=${c.ownerId}::uuid`);
    if (!owner[0]) throw new WorkCommandConflict("not_found");
    const inserted = await tx.execute(sql`INSERT INTO work_commands
      (owner_id,command_id,target_id,type,payload_hash,payload,expected_version)
      VALUES (${c.ownerId}::uuid,${c.commandId},${c.workId}::uuid,${c.type},${hash},${canonicalCommandJson(c.payload)}::jsonb,${c.expectedVersion})
      ON CONFLICT (owner_id,command_id) DO NOTHING RETURNING *`);
    if (!inserted[0]) {
      const existing = await tx.execute(sql`SELECT * FROM work_commands WHERE owner_id=${c.ownerId}::uuid AND command_id=${c.commandId}`);
      if (existing[0]?.payload_hash !== hash) throw new WorkCommandConflict("payload_conflict");
      return record(existing[0]);
    }
    // Lock order is command, Work, target version, event counter throughout.
    const owned = await tx.execute(sql`SELECT id FROM workshops WHERE id=${c.workId}::uuid AND user_id=${c.ownerId}::uuid FOR UPDATE`);
    if (!owned[0]) throw new WorkCommandConflict("not_found");
    await tx.execute(sql`INSERT INTO work_command_targets(workshop_id) VALUES (${c.workId}::uuid) ON CONFLICT DO NOTHING`);
    const current = await tx.execute(sql`SELECT version FROM work_command_targets WHERE workshop_id=${c.workId}::uuid FOR UPDATE`);
    if (current[0].version !== c.expectedVersion) throw new WorkCommandConflict("version_conflict");
    await appendWorkCommandAudit(tx, {ownerId: c.ownerId, commandId: c.commandId, workId: c.workId, phase: "accepted", metadata: {type: c.type, payloadHash: hash, expectedVersion: c.expectedVersion}});
    await append({workshopId: c.workId, type: "work_command_accepted", title: "Work command accepted",
      metadata: {commandId: c.commandId, commandType: c.type, payloadHash: hash, expectedVersion: c.expectedVersion}});
    return record(inserted[0]);
  });
}

type TransactionContext = Parameters<Parameters<typeof withWorkshopEventTransaction>[0]>;
/** DATABASE-LOCAL ONLY: handler must use tx, never global db, network, models,
 * processes or nested commands. Typed business rejection rolls back its writes
 * and commits a failed receipt; unexpected errors leave queued for explicit retry.
 * Handler consumes the persisted payload, not caller-supplied retry parameters.
 */
export async function executeLocalWorkCommand(
  ownerId: string, commandId: string, commandType: string,
  handler: (tx: TransactionContext[0], payload: CommandJson, append: TransactionContext[1]) => Promise<CommandJson>,
  executionLease?: ExecutionLease,
): Promise<WorkCommandRecord> {
  executionLease = resolveExecutionLease(executionLease);
  return withWorkshopEventTransaction(async (tx, append, savepoint) => {
    const rows = await tx.execute(sql`SELECT * FROM work_commands WHERE owner_id=${ownerId}::uuid AND command_id=${commandId} FOR UPDATE`);
    const row = rows[0];
    if (!row) throw new WorkCommandConflict("not_found");
    if (row.type !== commandType) throw new WorkCommandConflict("payload_conflict");
    const owned = await tx.execute(sql`SELECT id FROM workshops WHERE id=${row.target_id}::uuid AND user_id=${ownerId}::uuid FOR UPDATE`);
    if (!owned[0]) throw new WorkCommandConflict("not_found");
    if (row.status !== "queued") return record(row);
    if (executionLease && (executionLease.userId !== ownerId.toLowerCase() || executionLease.workshopId !== row.target_id)) throw new ExecutionLeaseError("invalid_lease");
    const executeQueued = async () => {
    const versions = await tx.execute(sql`SELECT version FROM work_command_targets WHERE workshop_id=${row.target_id}::uuid FOR UPDATE`);
    if (versions[0]?.version !== row.expected_version) {
      const failed = await tx.execute(sql`UPDATE work_commands SET status='failed',error_code='version_conflict',completed_at=now()
        WHERE owner_id=${ownerId}::uuid AND command_id=${commandId} RETURNING *`);
      await appendWorkCommandAudit(tx, {ownerId, commandId, workId: row.target_id, phase: "failed", metadata: {errorCode: "version_conflict"}});
      await append({workshopId: row.target_id, type: "work_command_failed", title: "Work command version conflict", metadata: {commandId, expectedVersion: row.expected_version, actualVersion: versions[0]?.version ?? null}});
      return record(failed[0]);
    }
    let result: string;
    try {
      result = await savepoint(async () => canonicalCommandJson(await handler(tx, row.payload, append)));
    } catch (error) {
      if (!(error instanceof WorkCommandConflict)) throw error;
      const failed = await tx.execute(sql`UPDATE work_commands SET status='failed',error_code=${error.code},completed_at=now()
        WHERE owner_id=${ownerId}::uuid AND command_id=${commandId} RETURNING *`);
      await appendWorkCommandAudit(tx, {ownerId, commandId, workId: row.target_id, phase: "failed", metadata: {errorCode: error.code}});
      await append({workshopId: row.target_id, type: "work_command_failed", title: "Work command rejected",
        metadata: {commandId, commandType: row.type, errorCode: error.code, expectedVersion: row.expected_version}});
      return record(failed[0]);
    }
    await tx.execute(sql`UPDATE work_command_targets SET version=version+1 WHERE workshop_id=${row.target_id}::uuid`);
    const completed = await tx.execute(sql`UPDATE work_commands SET status='succeeded',result=${result}::jsonb,completed_at=now()
      WHERE owner_id=${ownerId}::uuid AND command_id=${commandId} RETURNING *`);
    await appendWorkCommandAudit(tx, {ownerId, commandId, workId: row.target_id, phase: "succeeded", metadata: {version: row.expected_version + 1}});
    await append({workshopId: row.target_id, type: "work_command_applied", title: "Work command committed",
      metadata: {commandId, commandType: row.type, payloadHash: row.payload_hash, version: row.expected_version + 1}});
    return record(completed[0]);
    };
    // The capability belongs to this attempt, never the durable command payload.
    // Expiration must also roll back receipts, revisions and rejection events.
    return executionLease ? withExecutionBusinessTransaction(executionLease, {db: tx, append}, executeQueued) : executeQueued();
  });
}

/** Owner-scoped receipt survives target deletion; it never authorizes execution. */
export async function getWorkCommand(ownerId: string, commandId: string): Promise<WorkCommandRecord | null> {
  if (process.env.TAURI_MODE === "true" || process.env.IS_TAURI === "true") throw new Error("Work command ledger requires PostgreSQL");
  const rows = await db.execute(sql`SELECT * FROM work_commands WHERE owner_id=${ownerId}::uuid AND command_id=${commandId}`);
  return rows[0] ? record(rows[0]) : null;
}

/** Revision of this ledger only, not a claim about unmigrated legacy writers. */
export async function getWorkCommandVersion(ownerId: string, workId: string): Promise<number> {
  if (process.env.TAURI_MODE === "true" || process.env.IS_TAURI === "true") throw new Error("Work command ledger requires PostgreSQL");
  const rows = await db.execute(sql`SELECT COALESCE(t.version,0) AS version FROM workshops w
    LEFT JOIN work_command_targets t ON t.workshop_id=w.id WHERE w.id=${workId}::uuid AND w.user_id=${ownerId}::uuid`);
  if (!rows[0]) throw new WorkCommandConflict("not_found");
  return Number(rows[0].version);
}
