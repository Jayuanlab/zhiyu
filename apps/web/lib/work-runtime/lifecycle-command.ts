import {sql} from "drizzle-orm";
import {withWorkshopEventTransaction} from "@/lib/workshops/event-write";
import type {WorkshopWriteContext} from "@/lib/workshops/service";
import type {WorkCommandMeta} from "./types";
import {commandPayloadHash, canonicalCommandJson} from "./command-payload";
import {encodeCommandResult, decodeCommandResult} from "./database-command";
import {getWorkCommand, WorkCommandConflict} from "./command-ledger";
import {appendWorkCommandAudit} from "./command-audit";

/** Creation/deletion have no durable intermediate execution: target, receipt and
 * audit either all commit or all roll back. Do not put external work in handler.
 */
export async function runWorkLifecycleCommand<C extends WorkCommandMeta, T>(input: {
  ownerId: string; workId?: string; type: "createWork" | "createWorkFromManifest" | "deleteWork" | "migrateStandaloneLoop"; command: C;
  /** Read-only validation outside the transaction, skipped on committed replay.
   * No model/external action: an uncommitted attempt may validate again. */
  prepare?: () => Promise<void>;
}, handler: (command: C, context: WorkshopWriteContext, workId: string) => Promise<T>): Promise<T> {
  const id = input.command.commandId ?? crypto.randomUUID();
  const expected = input.command.expectedVersion;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuid.test(input.ownerId) || (input.workId !== undefined && !uuid.test(input.workId))) throw new WorkCommandConflict("invalid_command");
  if (typeof id !== "string" || !id.trim() || id.length > 256 ||
    (expected !== undefined && (!Number.isSafeInteger(expected) || expected < 0 || expected >= 2147483647)) ||
    (input.type !== "deleteWork" && expected !== undefined && expected !== 0)) throw new WorkCommandConflict("invalid_command");
  if (input.type === "deleteWork" && !input.workId) throw new WorkCommandConflict("invalid_command");
  const command = {...input.command, commandId: id, source: input.command.source ?? "owner", reason: input.command.reason ?? null};
  const payload = encodeCommandResult(command);
  const requestedTarget = input.workId?.toLowerCase() ?? null;
  // Server-generated target IDs are not part of creation intent identity.
  const hash = commandPayloadHash({contract: "work-lifecycle.v1", type: input.type, target: requestedTarget, payload});
  if (input.prepare) {
    const previous = await getWorkCommand(input.ownerId, id);
    if (previous) {
      if (previous.payloadHash !== hash || previous.type !== input.type) throw new WorkCommandConflict("payload_conflict");
      if (previous.status !== "succeeded") throw new Error("Lifecycle command receipt is incomplete");
      return decodeCommandResult<T>(previous.result);
    }
    await input.prepare();
  }
  return withWorkshopEventTransaction(async (tx, append) => {
    async function replay() {
      const rows = await tx.execute(sql`SELECT * FROM work_commands WHERE owner_id=${input.ownerId}::uuid AND command_id=${id}`);
      if (!rows[0]) return null;
      if (rows[0].payload_hash !== hash || rows[0].type !== input.type) throw new WorkCommandConflict("payload_conflict");
      if (rows[0].status !== "succeeded") throw new Error("Lifecycle command receipt is incomplete");
      return {value: decodeCommandResult<T>(rows[0].result)};
    }
    const previous = await replay();
    if (previous) return previous.value;
    const workId = requestedTarget ?? crypto.randomUUID();
    const inserted = await tx.execute(sql`INSERT INTO work_commands(owner_id,command_id,target_id,type,payload_hash,payload,expected_version)
      VALUES (${input.ownerId}::uuid,${id},${workId}::uuid,${input.type},${hash},${canonicalCommandJson(payload)}::jsonb,${expected ?? 0})
      ON CONFLICT(owner_id,command_id) DO NOTHING RETURNING command_id`);
    if (!inserted[0]) {
      const winner = await replay();
      if (!winner) throw new Error("Command winner missing");
      return winner.value;
    }
    if (input.type === "deleteWork") {
      const rows = await tx.execute(sql`SELECT id FROM workshops WHERE id=${workId}::uuid AND user_id=${input.ownerId}::uuid FOR UPDATE`);
      if (!rows[0]) throw new WorkCommandConflict("not_found");
      const versions = await tx.execute(sql`SELECT version FROM work_command_targets WHERE workshop_id=${workId}::uuid FOR UPDATE`);
      const version = versions[0]?.version ?? 0;
      if (expected !== undefined && expected !== version) throw new WorkCommandConflict("version_conflict");
      await tx.execute(sql`UPDATE work_commands SET expected_version=${version} WHERE owner_id=${input.ownerId}::uuid AND command_id=${id}`);
      await tx.execute(sql`SELECT id FROM loops WHERE workshop_id=${workId}::uuid ORDER BY id FOR UPDATE`);
      const active = await tx.execute(sql`SELECT 1 FROM workshop_runs WHERE workshop_id=${workId}::uuid AND status IN ('queued','running','cancel_requested','needs_review')
        UNION ALL SELECT 1 FROM loop_runs r JOIN loops l ON r.loop_id=l.id WHERE l.workshop_id=${workId}::uuid AND r.status IN ('queued','running','cancel_requested','needs_review')
        UNION ALL SELECT 1 FROM workshop_execution_leases WHERE workshop_id=${workId}::uuid AND phase IN ('running','needs_review') LIMIT 1`);
      if (active[0]) throw new WorkCommandConflict("target_busy");
    }
    await appendWorkCommandAudit(tx, {ownerId: input.ownerId, commandId: id, workId, phase: "accepted", metadata: {type: input.type, payloadHash: hash}});
    const result = await handler(decodeCommandResult<C>(payload), {db: tx, append}, workId);
    if (input.type !== "deleteWork") {
      await tx.execute(sql`INSERT INTO work_command_targets(workshop_id,version) VALUES (${workId}::uuid,1)`);
    }
    const encoded = encodeCommandResult(result);
    await tx.execute(sql`UPDATE work_commands SET status='succeeded',result=${canonicalCommandJson(encoded)}::jsonb,completed_at=now()
      WHERE owner_id=${input.ownerId}::uuid AND command_id=${id}`);
    await appendWorkCommandAudit(tx, {ownerId: input.ownerId, commandId: id, workId, phase: "succeeded", metadata: {type: input.type, targetDeleted: input.type === "deleteWork"}});
    return decodeCommandResult<T>(encoded);
  });
}
