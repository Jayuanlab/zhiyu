import { sql } from "drizzle-orm";
import type { DrizzleDB } from "@/lib/db/types";
import { MemoryIdentityConflict } from "../../kernel/reference-errors";

export type AuthorizedWorkRunStateSnapshot = {
  userId: string; workshopId: string; runId: string; content: Record<string, unknown>;
  sourceMemoryIds?: string[]; metadata: Record<string, unknown>;
};
/** The Work command already owns its transaction, run locks and terminal
 * authority. This adapter writes only its fixed work_state history row. */
export async function insertWorkRunStateSnapshotInTransaction(store: Pick<DrizzleDB, "execute">, input: AuthorizedWorkRunStateSnapshot): Promise<{ id: string }> {
  const rows = await store.execute(sql`INSERT INTO brain_state_snapshots(user_id,scope_type,scope_id,snapshot_type,content,source_memory_ids,metadata)
    SELECT ${input.userId}::uuid,'workshop',${input.workshopId},'work_state',${JSON.stringify(input.content)}::jsonb,
      ${JSON.stringify(input.sourceMemoryIds ?? [])}::jsonb,${JSON.stringify(input.metadata)}::jsonb
    FROM workshop_runs r JOIN workshops w ON w.id=r.workshop_id
    WHERE r.id=${input.runId}::uuid AND r.workshop_id=${input.workshopId}::uuid AND w.user_id=${input.userId}::uuid RETURNING brain_state_snapshots.id`);
  if (!rows[0] || typeof rows[0].id !== "string") throw new MemoryIdentityConflict();
  return { id: rows[0].id };
}
