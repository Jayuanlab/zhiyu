/** Real PostgreSQL control-plane verification. Every table used below is a
 * connection-local temporary copy; the outer transaction is rolled back.
 * No model, business worker, external provider or real owner data is executed. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { db, withDatabaseTransaction } from "../lib/db/client";
import { assignChatWorkshopTask } from "../lib/work-runtime/chat-task-command";
import { readChatWorkshopContext, reconcileChatWorkItemInTransaction } from "../lib/work-runtime/chat-work-items";
import { enqueueChatRunDeliveryInTransaction, deliverNextChatResultInTransaction } from "../lib/work-runtime/chat-delivery-store";
import { pauseAndCancelWorkRun } from "../lib/work-runtime/cancel-run";
import { claimWorkshopExecution } from "../lib/work-runtime/execution-lease";
import { getWorkCommandVersion } from "../lib/work-runtime/command-ledger";
import { appendWorkshopEvent, createWorkshopRun } from "../lib/workshops/service";
import { readAdmittedChatContinuation } from "../lib/work-runtime/chat-continuation";
import { getMessagesByChatId } from "../lib/db/chat-queries";
const ownerId = crypto.randomUUID(), chatId = crypto.randomUUID(), workId = crypto.randomUUID(), messageId = crypto.randomUUID();
const checks: string[] = [];
const rollback = new Error("verification_rollback");
try {
  await withDatabaseTransaction(async () => {
    await db.execute(sql`CREATE TEMP TABLE "Chat" (LIKE public."Chat" INCLUDING ALL)`);
    await db.execute(sql`CREATE TEMP TABLE "Message_v2" (LIKE public."Message_v2" INCLUDING ALL)`);
    for (const table of ["workshops", "workshop_runs", "workshop_directives", "work_commands", "work_command_targets", "work_command_events",
      "workshop_events", "workshop_event_counters", "workshop_execution_leases", "brain_state_snapshots", "workshop_runtime_snapshots", "workshop_loop_executions", "loop_runs", "loop_states"]) {
      // Table names are a fixed code list, never owner text.
      await db.execute(sql.raw(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING ALL)`));
    }
    await db.execute(sql`CREATE TEMP SEQUENCE verification_command_event_seq`);
    await db.execute(sql`ALTER TABLE work_command_events ALTER COLUMN seq SET DEFAULT nextval('verification_command_event_seq')`);
    const migration = await readFile(new URL("../lib/db/migrations/0160_add_workshop_chat_control.sql", import.meta.url), "utf8");
    const applyTemporaryMigration = async () => {
      // Execute every real statement without swallowing SQL failures. Only the
      // table namespace changes so fixtures never apply the public migration.
      for (const statement of migration.replaceAll("CREATE TABLE IF NOT EXISTS", "CREATE TEMP TABLE IF NOT EXISTS").split(";").map(s => s.trim()).filter(Boolean)) {
        await db.execute(sql.raw(statement));
      }
    };
    await applyTemporaryMigration();
    await db.execute(sql`INSERT INTO "Chat"(id,"userId",title,"createdAt",visibility) VALUES (${chatId}::uuid,${ownerId}::uuid,'isolated control test',now(),'private')`);
    await db.execute(sql`INSERT INTO workshops(id,user_id,name,mission,status) VALUES (${workId}::uuid,${ownerId}::uuid,'强化学习前沿学习者','研究强化学习','active')`);
    await db.execute(sql`INSERT INTO "Message_v2"(id,"chatId",role,parts,attachments,"createdAt")
      SELECT gen_random_uuid(),${chatId}::uuid,'user','[{"type":"text","text":"old"}]'::json,'[]'::json,now()-interval '1 day'+i*interval '1 second' FROM generate_series(1,1001) i`);
    const prompt = "让强化学习前沿学习者研究本周论文，并给出证据";
    await db.execute(sql`INSERT INTO "Message_v2"(id,"chatId",role,parts,attachments,"createdAt") VALUES
      (${messageId}::uuid,${chatId}::uuid,'user',${JSON.stringify([{ type: "text", text: prompt }])}::json,'[]'::json,clock_timestamp())`);
    const command = { userId: ownerId, workId, chatId, userMessageId: messageId, prompt, intentText: prompt, mode: "task" as const,
      commandId: "isolated-chat-task", source: "chat_agent" as const, expectedVersion: 0 };
    const accepted = await assignChatWorkshopTask(command);
    assert.equal(accepted.status, "queued");
    assert.deepEqual(await assignChatWorkshopTask(command), accepted);
    const counts = await db.execute(sql`SELECT (SELECT count(*)::int FROM workshop_runs) AS runs,(SELECT count(*)::int FROM workshop_directives) AS directives`);
    assert.equal(counts[0].runs, 1); assert.equal(counts[0].directives, 1);
    const context = await readChatWorkshopContext(ownerId, chatId);
    assert.equal(context?.runId, accepted.runId); assert.equal(context?.workItemId, accepted.workItemId);
    assert.equal(await readChatWorkshopContext(crypto.randomUUID(), chatId), null);
    checks.push("1001-message history: precise source, one admission, replay, owner isolation");
    await appendWorkshopEvent({ workshopId: workId, runId: accepted.runId, type: "directive_needs_clarification", title: "需要输入", body: "请说明要研究哪一周？" });
    await db.execute(sql`UPDATE workshop_runs SET status='completed',output_summary='请说明要研究哪一周？' WHERE id=${accepted.runId}::uuid`);
    await reconcileChatWorkItemInTransaction(db, { runId: accepted.runId, status: "completed", summary: "请说明要研究哪一周？" });
    assert.equal((await readChatWorkshopContext(ownerId, chatId))?.itemStatus, "needs_input");
    await enqueueChatRunDeliveryInTransaction(db, { userId: ownerId, workshopId: workId, runId: accepted.runId, status: "completed" });
    assert.equal((await deliverNextChatResultInTransaction(db, ownerId))?.state, "delivered");
    assert.equal(await deliverNextChatResultInTransaction(db, ownerId), null);
    const messages = await db.execute(sql`SELECT parts,metadata FROM "Message_v2" WHERE "chatId"=${chatId}::uuid AND role='assistant'`);
    assert.equal(messages.length, 1); assert.ok(JSON.stringify(messages[0].parts).includes("请说明要研究哪一周"));
    assert.ok((await getMessagesByChatId({ id: chatId, order: "latest" })).some(m => m.role === "assistant"));
    assert.equal((await readChatWorkshopContext(ownerId, chatId))?.revision, context?.revision);
    checks.push("clarification persists needs_input; original-chat delivery once; background keeps focus");
    const followId = crypto.randomUUID(), followPrompt = "只看上周的新论文";
    await db.execute(sql`INSERT INTO "Message_v2"(id,"chatId",role,parts,attachments,"createdAt") VALUES
      (${followId}::uuid,${chatId}::uuid,'user',${JSON.stringify([{ type: "text", text: followPrompt }])}::json,'[]'::json,clock_timestamp())`);
    const follow = await assignChatWorkshopTask({ ...command, userMessageId: followId, prompt: followPrompt,
      intentText: `${prompt}\n主人补充：${followPrompt}`, commandId: "isolated-continue", expectedVersion: 1,
      workItemId: accepted.workItemId, expectedItemRevision: 1, continuationFromRunId: accepted.runId });
    assert.equal(follow.workItemId, accepted.workItemId); assert.equal(follow.itemRevision, 2);
    const bound = await db.execute(sql`SELECT run_id,content FROM workshop_directives WHERE run_id=${follow.runId}::uuid`);
    assert.equal(bound.length, 1); assert.ok(bound[0].content.includes(prompt)); assert.ok(bound[0].content.includes(followPrompt));
    checks.push("clarification continues same item revision with complete primary input");
    const snapshots = await db.execute(sql`SELECT input_snapshot FROM workshop_runs WHERE id=${follow.runId}::uuid`);
    const pinned = await readAdmittedChatContinuation({ ownerId, workshopId: workId, snapshot: snapshots[0].input_snapshot }, db);
    assert.equal(pinned?.content, "请说明要研究哪一周？");
    await db.execute(sql`UPDATE workshop_runs SET output_summary='replaced result' WHERE id=${accepted.runId}::uuid`);
    await assert.rejects(readAdmittedChatContinuation({ ownerId, workshopId: workId, snapshot: snapshots[0].input_snapshot }, db), /source_changed/);
    await db.execute(sql`UPDATE workshop_runs SET output_summary='请说明要研究哪一周？' WHERE id=${accepted.runId}::uuid`);
    checks.push("continuation pins original output independent of event windows; changed hash refused");
    // Simulate legacy queued B, then exercise the actual command and claim guard.
    const queuedB = await createWorkshopRun({ workshopId: workId, status: "queued", triggerReason: { type: "manual" } });
    const stopped = await pauseAndCancelWorkRun({ userId: ownerId, workId, runId: follow.runId,
      commandId: "isolated-stop", expectedVersion: await getWorkCommandVersion(ownerId, workId), source: "owner" });
    assert.equal(stopped.futurePaused, true); assert.equal(stopped.status, "cancelled");
    const claim = await claimWorkshopExecution({ userId: ownerId, workshopId: workId, runId: queuedB.id, workerId: "isolated-test", leaseMs: 60000 });
    assert.equal(claim.state, "paused");
    checks.push("pause barrier and exact cancellation leave queued B unclaimable");

    // Populate pre-0160 fixtures directly. No command, executor or user data is
    // consulted: the backfill itself must establish its complete origin proof.
    const legacyWorkId = crypto.randomUUID();
    await db.execute(sql`INSERT INTO workshops(id,user_id,name,mission,status) VALUES
      (${legacyWorkId}::uuid,${ownerId}::uuid,'isolated legacy workshop','isolated migration fixture','active')`);
    const legacyPrompt = "让旧车间研究这周论文";
    const legacyCases: { name: string; recordCommand?: boolean; commandStatus?: string; parts: unknown }[] = [
      { name: "valid", parts: [{ type: "text", text: "让旧车间研究" }, { type: "image", url: "fixture" }, { type: "text", text: "这周论文" }] },
      { name: "missing_receipt", recordCommand: false, parts: [{ type: "text", text: legacyPrompt }] },
      { name: "unsuccessful_receipt", commandStatus: "queued", parts: [{ type: "text", text: legacyPrompt }] },
      { name: "failed_receipt", commandStatus: "failed", parts: [{ type: "text", text: legacyPrompt }] },
      { name: "text_mismatch", parts: [{ type: "text", text: "主人实际说的是另一个任务" }] },
      { name: "object_parts", parts: { type: "text", text: legacyPrompt } },
      { name: "string_parts", parts: legacyPrompt },
      { name: "null_parts", parts: null },
      { name: "nonstring_text", parts: [{ type: "text", text: { value: legacyPrompt } }] },
    ];
    const legacyOrigins = new Map<string, { chatId: string; messageId: string; runId: string }>();
    for (const fixture of legacyCases) {
      const origin = { chatId: crypto.randomUUID(), messageId: crypto.randomUUID(), runId: crypto.randomUUID() };
      legacyOrigins.set(fixture.name, origin);
      const commandId = `isolated-legacy-${fixture.name}`;
      const triggerReason = { type: "manual", source: "web_chat", origin: "chat_command", chatId: origin.chatId,
        userMessageId: origin.messageId, prompt: legacyPrompt, commandMeta: { commandId } };
      await db.execute(sql`INSERT INTO "Chat"(id,"userId",title,"createdAt",visibility) VALUES
        (${origin.chatId}::uuid,${ownerId}::uuid,'isolated legacy origin',now(),'private')`);
      await db.execute(sql`INSERT INTO "Message_v2"(id,"chatId",role,parts,attachments,"createdAt") VALUES
        (${origin.messageId}::uuid,${origin.chatId}::uuid,'user',${JSON.stringify(fixture.parts)}::json,'[]'::json,now())`);
      await db.execute(sql`INSERT INTO workshop_runs(id,workshop_id,status,trigger_reason,output_summary) VALUES
        (${origin.runId}::uuid,${legacyWorkId}::uuid,'completed',${JSON.stringify(triggerReason)}::jsonb,'isolated old result')`);
      if (fixture.recordCommand !== false) {
        const commandStatus = fixture.commandStatus ?? "succeeded";
        const result = commandStatus === "succeeded" ? JSON.stringify({ value: { run: { id: origin.runId } } }) : null;
        await db.execute(sql`INSERT INTO work_commands(owner_id,command_id,target_id,type,payload_hash,payload,expected_version,status,result,error_code,completed_at) VALUES
          (${ownerId}::uuid,${commandId},${legacyWorkId}::uuid,'startWorkRun',${"a".repeat(64)},
          ${JSON.stringify({ value: { source: "chat_agent", triggerReason } })}::jsonb,0,${commandStatus},
          ${result}::jsonb,${commandStatus === "failed" ? "isolated_fixture_failure" : null},
          CASE WHEN ${commandStatus}='queued' THEN NULL ELSE clock_timestamp() END)`);
      }
    }
    await applyTemporaryMigration();
    const recovered = await db.execute(sql`SELECT id,chat_id,source_message_id,latest_run_id,status,intent_text
      FROM workshop_chat_work_items WHERE workshop_id=${legacyWorkId}::uuid`);
    const valid = legacyOrigins.get("valid")!;
    assert.deepEqual(recovered.map(row => ({ ...row })), [{ id: valid.runId, chat_id: valid.chatId,
      source_message_id: valid.messageId, latest_run_id: valid.runId, status: "awaiting_acceptance", intent_text: legacyPrompt }]);
    const recoveredFocus = await db.execute(sql`SELECT chat_id,work_item_id,run_id,last_user_message_id
      FROM workshop_chat_contexts WHERE workshop_id=${legacyWorkId}::uuid`);
    assert.deepEqual(recoveredFocus.map(row => ({ ...row })), [{ chat_id: valid.chatId, work_item_id: valid.runId,
      run_id: valid.runId, last_user_message_id: valid.messageId }]);
    await applyTemporaryMigration();
    const replayed = await db.execute(sql`SELECT (SELECT count(*)::int FROM workshop_chat_work_items WHERE workshop_id=${legacyWorkId}::uuid) AS items,
      (SELECT count(*)::int FROM workshop_chat_contexts WHERE workshop_id=${legacyWorkId}::uuid) AS contexts`);
    assert.equal(replayed[0].items, 1); assert.equal(replayed[0].contexts, 1);
    checks.push("legacy backfill: exact successful receipt and multipart owner text accepted; missing/queued/failed receipts and mismatched text refused");
    checks.push("legacy malformed object/string/null parts and nonstring text are skipped; valid neighbor survives; migration replay stays one item/focus");
    throw rollback;
  });
} catch (error) {
  if (error !== rollback) {
    console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message.replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[connection]") : "verification_failed", checks }));
    process.exit(1);
  }
}
console.log(JSON.stringify({ ok: true, isolatedTemporaryTables: true, rolledBack: true, modelRuns: 0, externalActions: 0, checks }, null, 2));
process.exit(0);
