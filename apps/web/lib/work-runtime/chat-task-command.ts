import { sql } from "drizzle-orm";
import { addWorkshopDirective, createWorkshopRun, getWorkshop } from "@/lib/workshops/service";
import { runDatabaseWorkCommand } from "./database-command";
import { WorkCommandConflict } from "./command-ledger";
import { workCommandChildId } from "./child-id";
import { recordChatAdmission, requirePersistedChatTurn } from "./chat-work-items";
import type { WorkCommandMeta } from "./types";
import { chatContinuationHash, MAX_CHAT_CONTINUATION_RESULT, type ChatContinuationInput } from "./chat-continuation";

export type ChatTaskCommand = WorkCommandMeta & {
  userId: string; workId: string; chatId: string; userMessageId: string; prompt: string;
  intentText: string; mode: "task" | "ask"; workItemId?: string; expectedItemRevision?: number;
  parentRunId?: string;
  continuationFromRunId?: string;
};

/** One bounded task admission using the existing executor and ledger. No file
 * path parsed from conversational text becomes an input grant. */
export async function assignChatWorkshopTask(command: ChatTaskCommand) {
  if (!command.commandId || !command.intentText.trim() || command.intentText.length > 24_000 || command.prompt.length > 12_000
    || !["task", "ask"].includes(command.mode)) throw new WorkCommandConflict("invalid_command");
  return runDatabaseWorkCommand(command, "assignChatWorkshopTask", async (persisted, context) => {
    const inputs = await requirePersistedChatTurn(context.db, { ownerId: persisted.userId, chatId: persisted.chatId,
      userMessageId: persisted.userMessageId, prompt: persisted.prompt });
    if (inputs.hasAttachments) throw new WorkCommandConflict("input_not_available");
    const workshop = await getWorkshop(persisted.userId, persisted.workId, context.db);
    if (!workshop || workshop.status !== "active") throw new WorkCommandConflict("target_busy");
    const busy = await context.db.execute(sql`SELECT id,status FROM workshop_runs WHERE workshop_id=${persisted.workId}::uuid
      AND status IN ('queued','running','cancel_requested','needs_review') LIMIT 1`);
    if (busy[0]) throw new WorkCommandConflict("target_busy");
    const runId = workCommandChildId(persisted.userId, persisted.workId, persisted.commandId!, "run");
    const itemId = persisted.workItemId ?? workCommandChildId(persisted.userId, persisted.workId, persisted.commandId!, "chat-item");
    let continuation: ChatContinuationInput | undefined;
    if (persisted.workItemId) {
      if (!persisted.continuationFromRunId) throw new WorkCommandConflict("invalid_command");
      const prior = await context.db.execute(sql`SELECT r.output_summary FROM workshop_chat_work_items i JOIN workshop_runs r ON r.id=i.latest_run_id
        WHERE i.id=${persisted.workItemId}::uuid AND i.owner_id=${persisted.userId}::uuid AND i.chat_id=${persisted.chatId}::uuid
        AND i.workshop_id=${persisted.workId}::uuid AND i.revision=${persisted.expectedItemRevision}
        AND r.workshop_id=i.workshop_id AND r.id=${persisted.continuationFromRunId}::uuid
        AND r.status IN ('completed','failed','cancelled','interrupted') FOR SHARE OF r`);
      if (!prior[0]) throw new WorkCommandConflict("version_conflict");
      const content = String(prior[0].output_summary ?? "");
      if (content.length > MAX_CHAT_CONTINUATION_RESULT) throw new WorkCommandConflict("input_not_available");
      if (persisted.mode === "task") continuation = { sourceRunId: persisted.continuationFromRunId, resultHash: chatContinuationHash(content), content };
    }
    if (persisted.parentRunId) {
      if (persisted.mode !== "ask") throw new WorkCommandConflict("invalid_command");
      const parent = await context.db.execute(sql`SELECT id FROM workshop_runs WHERE id=${persisted.parentRunId}::uuid
        AND workshop_id=${persisted.workId}::uuid AND trigger_reason->>'type'='conversation'`);
      if (!parent[0]) throw new WorkCommandConflict("not_found");
    }
    const trigger: Record<string, unknown> = { type: persisted.mode === "ask" ? "conversation" : "directive",
      source: "web_chat", origin: "chat_command", once: true, chatId: persisted.chatId, userMessageId: persisted.userMessageId,
      prompt: persisted.prompt, content: persisted.mode === "ask" ? persisted.prompt : persisted.intentText, intentText: persisted.intentText, workItemId: itemId,
      continueWorkItem: Boolean(persisted.workItemId), expectedItemRevision: persisted.expectedItemRevision ?? null,
      parentRunId: persisted.parentRunId ?? null,
      inputFiles: [], commandMeta: { commandId: persisted.commandId, source: "chat_agent" } };
    const run = await createWorkshopRun({ id: runId, workshopId: persisted.workId, status: "queued", triggerReason: trigger,
      inputSnapshot: { mission: workshop.mission, acceptedByCommandId: persisted.commandId, workItemId: itemId,
        ...(continuation ? { chatContinuation: continuation } : {}) } }, context);
    if (persisted.mode === "task") {
      const directive = await addWorkshopDirective({ workshopId: persisted.workId, runId, content: persisted.intentText, scope: "current_run" }, context);
      trigger.directiveId = directive.id;
      await context.db.execute(sql`UPDATE workshop_runs SET trigger_reason=${JSON.stringify(trigger)}::jsonb WHERE id=${runId}::uuid`);
    }
    await recordChatAdmission(context.db, { ownerId: persisted.userId, workId: persisted.workId, runId,
      commandId: persisted.commandId!, triggerReason: trigger });
    await context.append({ workshopId: persisted.workId, runId, type: "chat_task_accepted", title: "对话交办已受理",
      metadata: { chatId: persisted.chatId, sourceMessageId: persisted.userMessageId, workItemId: itemId, commandId: persisted.commandId,
        mode: persisted.mode, continuation: Boolean(persisted.workItemId), admissionPolicy: "reject", maxConcurrentRuns: 1 } });
    return { runId: run.id, workItemId: itemId, workshopId: workshop.id, status: "queued", completed: false,
      adopted: false, itemRevision: (persisted.expectedItemRevision ?? 0) + 1 };
  });
}
