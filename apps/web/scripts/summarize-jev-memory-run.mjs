import fs from 'node:fs';
import path from 'node:path';
const folder = process.argv[2];
if (!folder) throw Error('Provide a run folder');
const run = JSON.parse(fs.readFileSync(path.join(folder, 'run.json'), 'utf8'));
const rows = run.cases.map(id => JSON.parse(fs.readFileSync(path.join(folder, `${id}.json`), 'utf8')));
const frequencies = values => Object.fromEntries([...new Set(values)].map(value => [value, values.filter(v => v === value).length]));
const routing = rows.flatMap(row => row.events.flatMap(event => {
  if (event.type !== 'reasoning') return [];
  try { const value = JSON.parse(event.content); return value.stage === 'jev_replaces_initial_recall_decision' ? [{ id: row.id, ...value }] : []; }
  catch { return []; }
}));
const latencies = rows.map(row => row.ms).filter(Number.isFinite).sort((a,b) => a-b);
const summary = { inputProtocol: run.inputProtocol, total: rows.length,
  statuses: frequencies(rows.map(row => row.status)),
  routes: { total: routing.length, statuses: frequencies(routing.map(row => row.status)),
    degradationReasons: frequencies(routing.filter(row => row.status === 'degraded').map(row => row.detail)),
    acceptedSources: frequencies(routing.filter(row => row.status === 'ok').map(row => (row.sources ?? []).join('+') || 'none')) },
  toolFailures: rows.flatMap(row => row.events.filter(event => event.type === 'tool_result' && event.isError).map(event => ({ id: row.id, toolUseId: event.toolUseId }))),
  unexpectedTools: rows.flatMap(row => (row.toolCalls ?? []).filter(call => !run.allowedTools.includes(call.name)).map(call => ({ id: row.id, name: call.name }))),
  requirementFailures: rows.filter(row => row.requirementCheck?.missingRequiredTools?.length || row.requirementCheck?.missingRequiredToolResults?.length).map(row => ({ id: row.id, ...row.requirementCheck })),
  latencyMs: { median: latencies[Math.ceil(latencies.length * 0.5)-1], p95: latencies[Math.ceil(latencies.length * 0.95)-1] },
  note: 'Transport/tool completion is not answer correctness. Original question labels and snapshot gold were never injected. Historical evidence gaps and direct boundary refusals require separate review.' };
fs.writeFileSync(path.join(folder, 'jev-run-audit.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
