import { and, eq, sql } from "drizzle-orm";
import type { DrizzleDB } from "@/lib/db/types";
import { chat, nativeAgentPlans, user } from "@/lib/db/schema";
import { MemoryModuleError } from "../../kernel/errors";
import { memoryPlanVersion, planPayloadSchema, type PlanRecord } from "../../plans/contracts";
const bad = () => new MemoryModuleError("memory_plan_unavailable", 503, "The persisted plan or source authority is unavailable");
type PlanSqlRow = { id: string; user_id: string; plan_id: string; revision: number; state: PlanRecord["state"]; origin: PlanRecord["origin"];
  plan_json: unknown; prompt_snapshot: string; input_observation_id: string; source_receipt_ids: unknown; version: string;
  parent_version: string | null; legacy_version: string | null; task_id: string | null; work_dir: string | null; expires_at: Date | string; created_at: Date | string };
function decode(row: PlanSqlRow): PlanRecord {
  if (!Array.isArray(row.source_receipt_ids) || !row.source_receipt_ids.every(value => typeof value === "string")
    || !["ready", "approved", "revoked"].includes(row.state) || !["generated", "owner_rebased_legacy"].includes(row.origin)) throw bad();
  const record: PlanRecord = { id: row.id, userId: row.user_id, planId: row.plan_id, revision: row.revision, state: row.state, origin: row.origin,
    plan: planPayloadSchema.parse(row.plan_json), promptSnapshot: row.prompt_snapshot, inputObservationId: row.input_observation_id,
    sourceReceiptIds: row.source_receipt_ids, version: row.version, parentVersion: row.parent_version, legacyVersion: row.legacy_version,
    taskId: row.task_id, workDir: row.work_dir, expiresAt: new Date(row.expires_at).toISOString(), createdAt: new Date(row.created_at).toISOString() };
  if (record.version !== memoryPlanVersion(record) || record.plan.id !== record.planId) throw bad();
  return record;
}
export async function lockPlanOwner(store: DrizzleDB, userId: string, taskId?: string | null) {
  const [owner] = await store.select({ id: user.id }).from(user).where(eq(user.id, userId)).for("share"); if (!owner) throw bad();
  if (taskId) { const [task] = await store.select({ id: chat.id }).from(chat).where(and(eq(chat.id, taskId), eq(chat.userId, userId))).for("share");
    if (!task) throw new MemoryModuleError("memory_plan_task_unavailable", 404, "Plan conversation unavailable"); }
}
export async function lockMemoryPlan(store: DrizzleDB, userId: string, planId: string, mode: "share" | "update") {
  const key = JSON.stringify(["memory-plan.v1", userId, planId]);
  await store.execute(mode === "share" ? sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${key},0))` : sql`SELECT pg_advisory_xact_lock(hashtextextended(${key},0))`);
}
export async function latestMemoryPlan(store: DrizzleDB, userId: string, planId: string): Promise<PlanRecord | null> {
  const rows = await store.execute(sql`SELECT * FROM memory_plan_records WHERE user_id=${userId}::uuid AND plan_id=${planId} ORDER BY revision DESC LIMIT 1 FOR SHARE`);
  return rows[0] ? decode(rows[0] as unknown as PlanSqlRow) : null;
}
export async function readPlanSourceForShare(store: DrizzleDB, userId: string, id: string): Promise<PlanRecord | null> {
  const identities = await store.execute(sql`SELECT plan_id FROM memory_plan_records WHERE user_id=${userId}::uuid AND id=${id}::uuid`);
  if (!identities[0]) return null;
  await lockMemoryPlan(store, userId, String(identities[0].plan_id), "share");
  const current = await latestMemoryPlan(store, userId, String(identities[0].plan_id));
  if (current) await lockPlanOwner(store, userId, current.taskId);
  return current?.id === id ? current : null;
}
export async function appendMemoryPlan(store: DrizzleDB, input: Omit<PlanRecord, "version">): Promise<PlanRecord> {
  const normalized = { ...input, id: input.id.toLowerCase(), userId: input.userId.toLowerCase(),
    inputObservationId: input.inputObservationId.toLowerCase(), taskId: input.taskId?.toLowerCase() ?? null,
    sourceReceiptIds: input.sourceReceiptIds.map(id => id.toLowerCase()) };
  const record = { ...normalized, version: memoryPlanVersion(normalized) };
  await store.execute(sql`INSERT INTO memory_plan_records(id,user_id,plan_id,revision,state,origin,plan_json,prompt_snapshot,input_observation_id,
    source_receipt_ids,version,parent_version,legacy_version,task_id,work_dir,expires_at,created_at) VALUES
    (${record.id}::uuid,${record.userId}::uuid,${record.planId},${record.revision},${record.state},${record.origin},${JSON.stringify(record.plan)}::jsonb,
    ${record.promptSnapshot},${record.inputObservationId}::uuid,${JSON.stringify(record.sourceReceiptIds)}::jsonb,${record.version},${record.parentVersion},
    ${record.legacyVersion},${record.taskId}::uuid,${record.workDir},${record.expiresAt}::timestamptz,${record.createdAt}::timestamptz)`);
  return record;
}
export async function lockPlanCommand(store: DrizzleDB, userId: string, commandId: string) {
  await store.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["memory-plan-command.v1", userId, commandId])},0))`);
}
export type PlanCommandRow = { id: string; requestHash: string; resultRecordId: string; action: string;
  executionState: "running" | "completed" | "failed" | "interrupted" | null; executionStartedAt: Date | null; executionFinishedAt: Date | null };
export async function readPlanCommand(store: DrizzleDB, userId: string, commandId: string): Promise<PlanCommandRow | null> {
  const rows = await store.execute(sql`SELECT id,request_hash AS "requestHash",result_record_id AS "resultRecordId",action,
    execution_state AS "executionState",execution_started_at AS "executionStartedAt",execution_finished_at AS "executionFinishedAt"
    FROM memory_plan_commands WHERE user_id=${userId}::uuid AND command_id=${commandId}::uuid FOR SHARE`);
  return rows[0] ? rows[0] as unknown as PlanCommandRow : null;
}
export async function recordPlanCommand(store: DrizzleDB, input: { id: string; userId: string; commandId: string; planId: string; action: string; requestHash: string; recordId: string }) {
  await store.execute(sql`INSERT INTO memory_plan_commands(id,user_id,command_id,plan_id,action,request_hash,result_record_id,execution_state,execution_started_at)
    VALUES(${input.id}::uuid,${input.userId}::uuid,${input.commandId}::uuid,${input.planId},${input.action},${input.requestHash},${input.recordId}::uuid,
    ${input.action === "approve" ? "running" : null},${input.action === "approve" ? new Date().toISOString() : null}::timestamptz)`);
}
export async function finishPlanCommand(store: DrizzleDB, userId: string, commandId: string, state: "completed" | "failed" | "interrupted") {
  await store.execute(sql`UPDATE memory_plan_commands SET execution_state=${state},execution_finished_at=now()
    WHERE user_id=${userId}::uuid AND command_id=${commandId}::uuid AND action='approve' AND execution_state='running'`);
}
export async function latestPlanExecution(store: DrizzleDB, userId: string, planId: string) {
  const rows = await store.execute(sql`SELECT execution_state AS state,execution_started_at AS "startedAt",execution_finished_at AS "finishedAt"
    FROM memory_plan_commands WHERE user_id=${userId}::uuid AND plan_id=${planId} AND action='approve' ORDER BY created_at DESC LIMIT 1 FOR SHARE`);
  return rows[0] ?? null;
}
export async function legacyMemoryPlan(store: DrizzleDB, userId: string, planId: string) {
  const [row] = await store.select().from(nativeAgentPlans).where(and(eq(nativeAgentPlans.ownerId, userId), eq(nativeAgentPlans.planId, planId))).for("share");
  return row ?? null;
}
export async function readMemoryPlanRecord(store: DrizzleDB, userId: string, id: string): Promise<PlanRecord | null> {
  const rows = await store.execute(sql`SELECT * FROM memory_plan_records WHERE user_id=${userId}::uuid AND id=${id}::uuid FOR SHARE`);
  return rows[0] ? decode(rows[0] as unknown as PlanSqlRow) : null;
}
