import assert from "node:assert/strict";
import { config } from "dotenv";
import postgres from "postgres";
config({ path: ".env.local", quiet: true });
config({ path: ".env", quiet: true });
const ownerId = process.env.ZHIYU_RUNTIME_OWNER_ID;
assert.ok(ownerId, "runtime_owner_missing");
const keyword = process.argv[2] || "deepseek";
const sql = postgres(process.env.POSTGRES_URL || process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
const clean = (value: unknown, max = 5000) => typeof value === "string"
  ? value.replace(/Bearer\s+\S+|\bsk-[A-Za-z0-9_-]{8,}|postgres(?:ql)?:\/\/\S+/gi, "[REDACTED]").slice(0, max) : value;
const textOf = (parts: unknown) => Array.isArray(parts) ? parts.filter(part => part?.type === "text").map(part => part.text).join("") : "";
try {
  await sql.begin("read only", async tx => {
    const matches = await tx`SELECT m.id,m."chatId" AS chat_id,m."createdAt"::text AS message_at,m.parts,c.title
      FROM "Message_v2" m JOIN "Chat" c ON c.id=m."chatId"
      WHERE c."userId"=${ownerId}::uuid AND m.role='user' AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(m.parts::jsonb)='array' THEN m.parts::jsonb ELSE '[]'::jsonb END) p
        WHERE p->>'type'='text' AND position(lower(${keyword}) in lower(p->>'text'))>0)
      ORDER BY m."createdAt" DESC,m.id DESC LIMIT 8`;
    console.log(JSON.stringify({ matches: matches.map(row => ({ id: row.id, chatId: row.chat_id, at: row.message_at, title: clean(row.title, 100), text: clean(textOf(row.parts), 1600) })) }));
    const latest = matches[0];
    if (!latest) return;
    const messages = await tx`SELECT id,role,parts,metadata,"createdAt"::text AS message_at FROM "Message_v2"
      WHERE "chatId"=${latest.chat_id}::uuid AND "createdAt">=${latest.message_at}::timestamp-interval '1 minute'
      ORDER BY "createdAt",id LIMIT 20`;
    const context = await tx`SELECT workshop_id,work_item_id,run_id,last_user_message_id,revision FROM workshop_chat_contexts
      WHERE owner_id=${ownerId}::uuid AND chat_id=${latest.chat_id}::uuid`;
    const items = await tx`SELECT i.id,i.revision,i.status,i.source_message_id,i.latest_run_id,i.intent_text,
      d.id AS directive_id,d.content,d.scope,d.status AS directive_status,r.status AS run_status,r.error,r.output_summary,
      r.trigger_reason,r.input_snapshot,r.created_at,r.completed_at FROM workshop_chat_work_items i
      LEFT JOIN workshop_directives d ON d.id=i.primary_directive_id LEFT JOIN workshop_runs r ON r.id=i.latest_run_id
      WHERE i.owner_id=${ownerId}::uuid AND i.chat_id=${latest.chat_id}::uuid ORDER BY i.updated_at DESC LIMIT 5`;
    const commandIds = items.map(item => item.trigger_reason?.commandMeta?.commandId).filter(Boolean);
    const commands = await tx`SELECT command_id,target_id,type,status,error_code,payload,result,created_at,completed_at FROM work_commands
      WHERE owner_id=${ownerId}::uuid AND (command_id=ANY(${commandIds}::text[]) OR payload->>'userMessageId'=${latest.id}::text OR payload->>'chatId'=${latest.chat_id}::text)
      ORDER BY created_at DESC LIMIT 8`;
    const runIds = [...new Set(items.map(item => item.latest_run_id).filter(Boolean))];
    const events = runIds.length ? await tx`SELECT id,run_id,type,title,body,metadata,created_at FROM workshop_events
      WHERE workshop_id IN (SELECT id FROM workshops WHERE user_id=${ownerId}::uuid) AND run_id=ANY(${runIds}::uuid[])
      ORDER BY created_at,id LIMIT 120` : [];
    console.log(JSON.stringify({ selectedMessageId: latest.id, chatId: latest.chat_id, context,
      messages: messages.map(row => ({ id: row.id, role: row.role, at: row.message_at, text: clean(textOf(row.parts)),
        partTypes: Array.isArray(row.parts) ? row.parts.map(part => part.type) : [],
        tools: Array.isArray(row.parts) ? row.parts.filter(part => part.type === "tool-native").map(part => ({ name: part.toolName ?? part.name,
          keys: Object.keys(part), input: part.toolInput ?? part.input ?? part.args, state: part.status ?? part.state, output: clean(JSON.stringify(part.toolOutput ?? part.output ?? part.result), 1800) })) : [],
        delivery: row.metadata?.workshopChatDelivery ?? null })),
      items: items.map(item => ({ ...item, intent_text: clean(item.intent_text), content: clean(item.content), output_summary: clean(item.output_summary),
        trigger_reason: clean(JSON.stringify(item.trigger_reason), 1200), input_snapshot: clean(JSON.stringify(item.input_snapshot), 7000), error: clean(item.error) })),
      commands: commands.map(command => ({ ...command, payload: clean(JSON.stringify(command.payload), 1800), result: clean(JSON.stringify(command.result), 1800) })),
      events: events.map(event => ({ id: event.id, run_id: event.run_id, type: event.type, title: clean(event.title, 200), body: clean(event.body, 1800),
        toolName: event.metadata?.toolName ?? null, metadata: clean(JSON.stringify(event.metadata), 1400), at: event.created_at })) }));
  });
} catch (error) {
  console.error(JSON.stringify({ ok: false, code: (error as any)?.code, reason: error instanceof assert.AssertionError ? error.message : "instruction_read_failed" }));
  process.exitCode = 1;
} finally { await sql.end({ timeout: 2 }); }
