import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { decodeCommandResult } from "./database-command";
import { readPausedLoopControlFeedback, type LoopControlFeedbackSubject,
  type LoopControlFeedbackSnapshot } from "./loop-control-feedback";

/** One fresh statement binds identity, database time, config and immutable ledger receipt.
 * No write capability, scheduler call, clock update, model or detached retry. */
export function readWorkLoopControlFeedbackForOwner(input: {
  userId: string; workId: string; loopId: string; commandId: string;
}) {
  const subject: LoopControlFeedbackSubject = { ownerId: input.userId, workId: input.workId,
    loopId: input.loopId, commandId: input.commandId };
  return readPausedLoopControlFeedback(subject, async requested => {
    const rows = await db.execute(sql`SELECT clock_timestamp() AS observed_at,
      w.user_id AS owner_id,w.id AS work_id,w.status AS work_status,
      p.id AS loop_id,p.status AS loop_status,p.updated_at AS loop_updated_at,
      COALESCE(t.version,0) AS work_command_version,
      c.command_id,c.target_id,c.type AS command_type,c.status AS command_status,
      c.expected_version,c.completed_at,c.result AS command_result
      FROM workshops w JOIN loops p ON p.workshop_id=w.id AND p.user_id=w.user_id
      LEFT JOIN work_command_targets t ON t.workshop_id=w.id
      LEFT JOIN work_commands c ON c.owner_id=w.user_id AND c.target_id=w.id
        AND c.command_id=${requested.commandId}
      WHERE w.id=${requested.workId}::uuid AND w.user_id=${requested.ownerId}::uuid
        AND p.id=${requested.loopId}::uuid LIMIT 1`);
    const row = rows[0] as Record<string, any> | undefined;
    if (!row) return null;
    const decoded = row.command_id && row.command_status === "succeeded"
      ? decodeCommandResult<{ loop?: any }>(row.command_result) : null;
    return { ownerId: row.owner_id, workId: row.work_id, loopId: row.loop_id,
      observedAt: row.observed_at, workStatus: row.work_status, loopStatus: row.loop_status,
      loopUpdatedAt: row.loop_updated_at, workCommandVersion: Number(row.work_command_version),
      command: row.command_id ? { commandId: row.command_id, workId: row.target_id,
        type: row.command_type, status: row.command_status, expectedVersion: row.expected_version,
        completedAt: row.completed_at, result: row.command_result, appliedLoop: decoded?.loop ?? null } : null,
    } satisfies LoopControlFeedbackSnapshot;
  });
}
