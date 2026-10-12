import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { config } from "dotenv";
import postgres from "postgres";
config({ path: ".env.local", quiet: true }); config({ path: ".env", quiet: true });
const chatId = process.argv[2]; assert.match(chatId, /^[0-9a-f-]{36}$/i);
const ownerId = process.env.ZHIYU_RUNTIME_OWNER_ID!;
const sql = postgres(process.env.POSTGRES_URL || process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
try {
  const chat = await sql`SELECT id FROM "Chat" WHERE id=${chatId}::uuid AND "userId"=${ownerId}::uuid`;
  assert.equal(chat.length, 1, "test_chat_not_owned");
  const context = await sql`SELECT workshop_id,work_item_id,run_id,last_user_message_id,revision FROM workshop_chat_contexts
    WHERE owner_id=${ownerId}::uuid AND chat_id=${chatId}::uuid`;
  const items = await sql`SELECT i.id,i.source_message_id,i.latest_run_id,i.primary_directive_id,i.revision,i.status,
    r.status AS run_status,r.trigger_reason->>'type' AS run_type,r.trigger_reason->'commandMeta'->>'commandId' AS command_id,
    r.output_summary,r.error,d.content AS primary_input
    FROM workshop_chat_work_items i LEFT JOIN workshop_runs r ON r.id=i.latest_run_id
    LEFT JOIN workshop_directives d ON d.id=i.primary_directive_id WHERE i.owner_id=${ownerId}::uuid AND i.chat_id=${chatId}::uuid ORDER BY i.created_at`;
  const deliveries = await sql`SELECT id,run_id,source_message_id,message_id,status,attempts,last_error_code,delivered_at
    FROM workshop_chat_deliveries WHERE owner_id=${ownerId}::uuid AND chat_id=${chatId}::uuid ORDER BY created_at`;
  const messages = await sql`SELECT id,role,parts,metadata,"createdAt" FROM "Message_v2" WHERE "chatId"=${chatId}::uuid ORDER BY "createdAt",id`;
  const events = context[0]?.workshop_id ? await sql`SELECT e.id,e.run_id,e.type,e.metadata->>'toolName' AS tool_name,
    CASE WHEN e.type='directive_plan_failed' THEN e.body END AS planner_error FROM workshop_events e
    WHERE e.run_id IN (SELECT latest_run_id FROM workshop_chat_work_items WHERE owner_id=${ownerId}::uuid AND chat_id=${chatId}::uuid)
    ORDER BY e.created_at,e.id` : [];
  const redact = (text: unknown) => typeof text === "string" ? text.replace(/Bearer\s+\S+|\bsk-[A-Za-z0-9_-]{8,}|postgres(?:ql)?:\/\/\S+/gi, "[REDACTED]") : text;
  const claimedIds = [...new Set(messages.filter(message => message.role === "assistant").flatMap(message =>
    (Array.isArray(message.parts) ? message.parts.filter((part: any) => part.type === "text").map((part: any) => part.text).join("") : "")
      .match(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/gi) ?? []))].filter(id => id !== context[0]?.workshop_id);
  const claimedRecords = claimedIds.length ? await sql`SELECT r.id,r.workshop_id,r.status FROM workshop_runs r JOIN workshops w ON w.id=r.workshop_id
    WHERE w.user_id=${ownerId}::uuid AND r.id=ANY(${claimedIds}::uuid[])` : [];
  const claims = claimedIds.map(id => ({ id, actualRun: claimedRecords.find(row => row.id === id) ?? null }));
  const deliveryChecks = deliveries.map(delivery => ({ runId: delivery.run_id, messageId: delivery.message_id,
    matchingMessages: messages.filter(message => message.id === delivery.message_id && message.role === "assistant"
      && message.metadata?.workshopChatDelivery?.deliveryId === delivery.id).length }));
  const report = { at: new Date().toISOString(), chatId, context, items: items.map(item => ({ ...item,
    output_summary: redact(item.output_summary), error: redact(item.error), primary_input: redact(item.primary_input) })), deliveries,
    messages: messages.map(message => ({ id: message.id, role: message.role, at: message.createdAt,
      partTypes: Array.isArray(message.parts) ? message.parts.map((part: any) => part.type) : [],
      text: redact(Array.isArray(message.parts) ? message.parts.filter((part: any) => part.type === "text").map((part: any) => part.text).join("") : ""),
      toolNames: Array.isArray(message.parts) ? message.parts.filter((part: any) => part.type === "tool-native").map((part: any) => part.toolName ?? part.name ?? "unknown") : [],
      delivery: message.metadata?.workshopChatDelivery ?? null })), events: events.map(event => ({ ...event, planner_error: redact(event.planner_error) })), claims, deliveryChecks };
  const directory = new URL("../../../docs/verification/artifacts/workshop-chat-control-2026-10-09/", import.meta.url);
  await mkdir(directory, { recursive: true });
  await writeFile(new URL(`chat-${chatId}.json`, directory), JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log(JSON.stringify({ ok: true, ...report }));
} catch (error) {
  console.error(JSON.stringify({ ok: false, reason: error instanceof assert.AssertionError ? error.message : "production_read_failed", code: (error as any)?.code }));
  process.exitCode = 1;
} finally { await sql.end({ timeout: 2 }); }
