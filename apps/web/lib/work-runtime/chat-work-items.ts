import { sql } from "drizzle-orm";
import type { WorkshopWriteContext } from "@/lib/workshops/service";
import { workCommandChildId } from "./child-id";
import { WorkCommandConflict } from "./command-ledger";

type Store = WorkshopWriteContext["db"];
export type ChatWorkshopContext = {
  workshopId: string; workItemId: string | null; runId: string | null; revision: number;
  itemRevision: number | null; itemStatus: string | null; intentText: string | null; resultSummary: string | null;
  itemMode?: string | null;
};

/** Exact persisted owner turn, independent of the full chat history window. */
export async function requirePersistedChatTurn(tx: Store, input: {
  ownerId: string; chatId: string; userMessageId: string; prompt: string;
}) {
  const rows = await tx.execute(sql`SELECT m.parts,m.attachments FROM "Message_v2" m JOIN "Chat" c ON c.id=m."chatId"
    WHERE c.id=${input.chatId}::uuid AND c."userId"=${input.ownerId}::uuid
    AND m.id=${input.userMessageId}::uuid AND m.role='user'
    AND NOT EXISTS (SELECT 1 FROM "Message_v2" newer WHERE newer."chatId"=c.id AND newer.role='user'
      AND newer.id<>m.id AND newer."createdAt">=m."createdAt") FOR SHARE OF c,m`);
  const parts = rows[0]?.parts;
  const text = Array.isArray(parts) ? parts.filter(p => p?.type === "text" && typeof p.text === "string").map(p => p.text).join("") : null;
  if (text !== input.prompt) throw new WorkCommandConflict("invalid_command");
  return { hasAttachments: (Array.isArray(rows[0]?.attachments) && rows[0].attachments.length > 0)
    || (Array.isArray(parts) && parts.some(p => p?.type === "file")) };
}

export async function readChatWorkshopContext(ownerId: string, chatId: string, store?: Store): Promise<ChatWorkshopContext | null> {
  const tx = store ?? (await import("@/lib/db/client")).db;
  const rows = await tx.execute(sql`SELECT x.workshop_id AS "workshopId",x.work_item_id AS "workItemId",x.run_id AS "runId",x.revision,
    i.revision AS "itemRevision",CASE WHEN r.status='running' THEN 'running' ELSE i.status END AS "itemStatus",i.intent_text AS "intentText",i.result_summary AS "resultSummary",r.trigger_reason->>'type' AS "itemMode"
    FROM workshop_chat_contexts x JOIN "Chat" c ON c.id=x.chat_id AND c."userId"=x.owner_id
    JOIN workshops w ON w.id=x.workshop_id AND w.user_id=x.owner_id
    LEFT JOIN workshop_chat_work_items i ON i.id=x.work_item_id AND i.owner_id=x.owner_id AND i.chat_id=x.chat_id AND i.workshop_id=w.id
    LEFT JOIN workshop_runs r ON r.id=x.run_id AND r.workshop_id=w.id
    WHERE x.owner_id=${ownerId}::uuid AND x.chat_id=${chatId}::uuid`);
  return (rows[0] as unknown as ChatWorkshopContext) ?? null;
}

/** Called inside the same admission transaction. Background results never call this. */
export async function recordChatAdmission(tx: Store, input: {
  ownerId: string; workId: string; runId: string; commandId: string; triggerReason: Record<string, unknown>;
}) {
  const trigger = input.triggerReason;
  if (trigger.source !== "web_chat" || trigger.origin !== "chat_command") return null;
  if (typeof trigger.chatId !== "string" || typeof trigger.userMessageId !== "string" || typeof trigger.prompt !== "string") {
    throw new WorkCommandConflict("invalid_command");
  }
  await requirePersistedChatTurn(tx, { ownerId: input.ownerId, chatId: trigger.chatId, userMessageId: trigger.userMessageId, prompt: trigger.prompt });
  const itemId = typeof trigger.workItemId === "string" ? trigger.workItemId : workCommandChildId(input.ownerId, input.workId, input.commandId, "chat-item");
  if (trigger.continueWorkItem === true) {
    const changed = await tx.execute(sql`UPDATE workshop_chat_work_items SET latest_run_id=${input.runId}::uuid,
      primary_directive_id=${typeof trigger.directiveId === "string" ? trigger.directiveId : null}::uuid,
      revision=revision+1,status='queued',intent_text=${String(trigger.intentText)},result_summary=NULL,updated_at=clock_timestamp()
      WHERE id=${itemId}::uuid AND owner_id=${input.ownerId}::uuid AND chat_id=${trigger.chatId}::uuid AND workshop_id=${input.workId}::uuid
      AND revision=${Number(trigger.expectedItemRevision)} AND status IN ('needs_input','awaiting_acceptance','failed','cancelled') RETURNING id`);
    if (!changed[0]) throw new WorkCommandConflict("version_conflict");
  } else {
    await tx.execute(sql`INSERT INTO workshop_chat_work_items(id,owner_id,chat_id,workshop_id,source_message_id,primary_directive_id,latest_run_id,intent_text)
      VALUES (${itemId}::uuid,${input.ownerId}::uuid,${trigger.chatId}::uuid,${input.workId}::uuid,${trigger.userMessageId}::uuid,
      ${typeof trigger.directiveId === "string" ? trigger.directiveId : null}::uuid,${input.runId}::uuid,${typeof trigger.intentText === "string" ? trigger.intentText : trigger.prompt})`);
  }
  await tx.execute(sql`INSERT INTO workshop_chat_contexts(owner_id,chat_id,workshop_id,work_item_id,run_id,last_user_message_id)
    VALUES (${input.ownerId}::uuid,${trigger.chatId}::uuid,${input.workId}::uuid,${itemId}::uuid,${input.runId}::uuid,${trigger.userMessageId}::uuid)
    ON CONFLICT(owner_id,chat_id) DO UPDATE SET workshop_id=excluded.workshop_id,work_item_id=excluded.work_item_id,
      run_id=excluded.run_id,last_user_message_id=excluded.last_user_message_id,revision=workshop_chat_contexts.revision+1,updated_at=clock_timestamp()`);
  return itemId;
}

export function projectChatWorkItemStatus(status: string, needsInput: boolean) {
  if (status === "completed") return needsInput ? "needs_input" : "awaiting_acceptance";
  if (status === "needs_review") return "needs_review";
  if (status === "interrupted") return "failed";
  if (status === "cancelled" || status === "failed") return status;
  return status === "running" ? "running" : "queued";
}

export async function reconcileChatWorkItemInTransaction(tx: Store, input: {
  runId: string; status: string; summary?: string | null; error?: string | null;
}) {
  const clarification = input.status === "completed" ? await tx.execute(sql`SELECT id FROM workshop_events
    WHERE run_id=${input.runId}::uuid AND type='directive_needs_clarification' LIMIT 1`) : [];
  await tx.execute(sql`UPDATE workshop_chat_work_items SET status=${projectChatWorkItemStatus(input.status, Boolean(clarification[0]))},
    result_summary=${input.summary ?? input.error ?? null},updated_at=clock_timestamp() WHERE latest_run_id=${input.runId}::uuid`);
}
