import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { config } from 'dotenv';
import postgres from 'postgres';

config({ path: '.env.local', quiet: true });
config({ path: '.env', quiet: true });
const chatId = process.argv[2];
assert.match(chatId ?? '', /^[0-9a-f-]{36}$/i);
const ownerId = 'dcb1985e-3fe2-42fd-8978-7b04d1772850';
const dbUrl = process.env.POSTGRES_URL || process.env.DATABASE_URL;
assert(dbUrl && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(dbUrl).hostname));
const sql = postgres(dbUrl, { max: 1, connect_timeout: 5, onnotice: () => {}, connection: { statement_timeout: 10000 } });

function routingEvents(value, found = []) {
  if (typeof value === 'string') {
    try { const parsed = JSON.parse(value); if (parsed?.stage === 'jev_replaces_initial_recall_decision') found.push(parsed); }
    catch { /* Ordinary prose is not a routing event. */ }
  } else if (Array.isArray(value)) value.forEach(item => routingEvents(item, found));
  else if (value && typeof value === 'object') {
    if (value.stage === 'jev_replaces_initial_recall_decision') found.push(value);
    else Object.values(value).forEach(item => routingEvents(item, found));
  }
  return found;
}
function describe(row) {
  return { messageId: row.id, chatId: row.chatId, at: row.at, events: routingEvents(row.parts).map(event => ({
    status: event.status, detail: event.detail, model: event.model, elapsedMs: event.elapsedMs,
    sources: event.sources, sourceProbabilities: event.sourceProbabilities, uncertainSources: event.uncertainSources,
    thresholds: event.thresholds, policyVersion: event.policyVersion, schemaVersion: event.schemaVersion,
    applicationRoute: event.applicationRoute, inputHash: event.inputHash,
  })) };
}
try {
  const observed = await sql.begin('isolation level repeatable read read only', async tx => {
    const chat = await tx`SELECT id FROM "Chat" WHERE id=${chatId}::uuid AND "userId"=${ownerId}::uuid`;
    assert.equal(chat.length, 1, 'owner_chat_not_found');
    const selected = await tx`SELECT id,"chatId","createdAt"::text AS at,parts FROM "Message_v2"
      WHERE "chatId"=${chatId}::uuid AND role='assistant' ORDER BY "createdAt" DESC,id DESC LIMIT 20`;
    const recent = await tx`SELECT m.id,m."chatId",m."createdAt"::text AS at,m.parts FROM "Message_v2" m
      JOIN "Chat" c ON c.id=m."chatId" WHERE c."userId"=${ownerId}::uuid AND m.role='assistant'
      AND m.parts::text LIKE '%jev_replaces_initial_recall_decision%'
      ORDER BY m."createdAt" DESC,m.id DESC LIMIT 30`;
    return { selected: selected.map(describe), recent: recent.map(describe) };
  });
  const events = observed.selected.flatMap(row => row.events);
  const trends = observed.recent.flatMap(row => row.events).reduce((counts,event) => {
    const key = event.detail ?? event.status ?? 'unknown'; counts[key] = (counts[key] ?? 0) + 1; return counts;
  }, {});
  const report = { at: new Date().toISOString(), chatId, selectedEventCount: events.length,
    currentChatLatestEvent: events[0] ?? null, recentRoutingCounts: trends,
    localConfig: { routing: process.env.BRAIN_JEV_ROUTING ?? null, keyPresent: !!process.env.TYPESAFE_API_KEY },
    ...observed, readsOnly: true, businessRunsStarted: 0 };
  const dir = new URL('../../../docs/verification/artifacts/jev-availability-2026-10-09/', import.meta.url);
  await mkdir(dir,{recursive:true});
  const name = `chat-${chatId}-${report.at.replaceAll(/[:.]/g,'-')}.json`;
  await writeFile(new URL(name,dir),JSON.stringify(report,null,2)+'\n',{encoding:'utf8',flag:'wx'});
  console.log(JSON.stringify(report));
  if (!events.length || events[0].status !== 'ok') process.exitCode=2;
} finally { await sql.end(); }
