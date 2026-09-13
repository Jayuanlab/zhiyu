import {sql} from "drizzle-orm";
import {db} from "@/lib/db/client";
import type {DrizzleDB} from "@/lib/db/types";
import {canonicalCommandJson, type CommandJson} from "./command-payload";

export async function appendWorkCommandAudit(tx: DrizzleDB, input: {
  ownerId: string; commandId: string; workId: string;
  phase: "accepted" | "succeeded" | "failed"; metadata: CommandJson;
}) {
  await tx.execute(sql`INSERT INTO work_command_events(owner_id,command_id,target_id,phase,metadata)
    VALUES (${input.ownerId}::uuid,${input.commandId},${input.workId}::uuid,${input.phase},${canonicalCommandJson(input.metadata)}::jsonb)`);
}

export async function listWorkCommandAudit(ownerId: string, commandId: string) {
  if (process.env.TAURI_MODE === "true" || process.env.IS_TAURI === "true") throw new Error("Work command audit requires PostgreSQL");
  return db.execute(sql`SELECT seq::text AS seq,phase,metadata,created_at AS "createdAt" FROM work_command_events
    WHERE owner_id=${ownerId}::uuid AND command_id=${commandId} ORDER BY work_command_events.seq`);
}
