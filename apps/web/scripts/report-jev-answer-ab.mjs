import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const [off, active] = process.argv.slice(2, 4).map(value => path.resolve(value));
const replacement = process.argv.includes('--replacement');
const rubricV2 = process.argv.includes('--rubric-v2');
const historical = process.argv.includes('--historical');
if (!off || !active) throw new Error('Two evaluated run folders required');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const pass = grade => ['complete', 'boundary_pass'].includes(grade.outcome);
function load(folder) {
  const grades = read(path.join(folder, rubricV2 ? 'pi-answer-judge-v2/grades.json' : 'pi-answer-judge/grades.json'));
  if (grades.length !== 100 || new Set(grades.map(g => g.id)).size !== 100) throw new Error('All 100 grades required');
  const rows = grades.map(g => read(path.join(folder, `${g.id}.json`)));
  const checks = rows.flatMap(row => row.events.filter(event => event.type === 'tool_result').flatMap(event => {
    try { const result = typeof event.output === 'string' ? JSON.parse(event.output) : event.output; return result?.evidenceCheck ? [{ id: row.id, ...result.evidenceCheck }] : []; } catch { return []; }
  }));
  const times = rows.map(row => row.ms).sort((a, b) => a - b);
  const routing = rows.flatMap(row => row.events.filter(e => e.type === 'reasoning').flatMap(e => {
    try { const r = JSON.parse(e.content); return r.stage === 'jev_replaces_initial_recall_decision' ? [{ id: row.id, ...r }] : []; } catch { return []; }
  }));
  const metrics = { total: 100, sufficient: grades.filter(pass).length, factualComplete: grades.filter(g => g.outcome === 'complete').length,
    completed: rows.filter(row => row.status === 'completed').length,
    outcomes: Object.fromEntries([...new Set(grades.map(g => g.outcome))].map(outcome => [outcome, grades.filter(g => g.outcome === outcome).length])),
    latencyMs: { median: (times[49] + times[50]) / 2, p95: times[94], sum: times.reduce((a,b) => a+b,0) },
    mainModelTurns: rows.reduce((n,r) => n + r.events.filter(e => e.type === 'result').length, 0),
    routing: { total: routing.length, ok: routing.filter(r => r.status === 'ok').length,
      degraded: routing.filter(r => r.status === 'degraded'),
      prefetched: rows.filter(r => r.toolCalls.some(t => t.id?.startsWith('jev-prefetch:'))).length },
    failedRequests: rows.filter(row => row.status !== 'completed').map(row => ({ id: row.id, status: row.status })),
    jev: { visibleChecks: checks.length, ok: checks.filter(c => c.status === 'ok').length, degraded: checks.filter(c => c.status === 'degraded').length,
      reasons: Object.fromEntries([...new Set(checks.filter(c => c.detail).map(c => c.detail))].map(detail => [detail, checks.filter(c => c.detail === detail).length])) },
  };
  return { metrics, grades, rows };
}
const baseline = load(off), candidate = load(active);
if (rubricV2 && read(path.join(off, 'pi-answer-judge-v2/summary.json')).rubricHash !== read(path.join(active, 'pi-answer-judge-v2/summary.json')).rubricHash) throw Error('Rubric hashes differ');
const byId = new Map(baseline.grades.map(g => [g.id, g]));
const changes = candidate.grades.filter(g => pass(g) !== pass(byId.get(g.id))).map(g => ({ id: g.id, before: byId.get(g.id), after: g }));
function records(row) {
  const items = new Map();
  for (const event of row.events.filter(e => e.type === 'tool_result')) {
    try {
      const output = typeof event.output === 'string' ? JSON.parse(event.output) : event.output;
      for (const record of output?.data?.records?.records ?? []) items.set(`${record.source}:${record.id}`, createHash('sha256').update(JSON.stringify(record.fields)).digest('hex'));
    } catch {}
  }
  return items;
}
let sharedRecords = 0;
const changedRecords = [];
for (const before of baseline.rows) {
  const after = candidate.rows.find(row => row.id === before.id);
  const a = records(before), b = records(after);
  for (const [id, hash] of a) if (b.has(id)) { sharedRecords++; if (b.get(id) !== hash) changedRecords.push({ questionId: before.id, recordId: id }); }
}
const delta = candidate.metrics.sufficient - baseline.metrics.sufficient;
const report = { createdAt: new Date().toISOString(), baseline: off, candidate: active,
  before: baseline.metrics, after: candidate.metrics, percentagePointChange: delta,
  evidenceComparability: { sharedRecordComparisons: sharedRecords, changedRecords },
  relativePercentChange: baseline.metrics.sufficient ? Number((100 * delta / baseline.metrics.sufficient).toFixed(2)) : null,
  improved: changes.filter(g => pass(g.after)), regressed: changes.filter(g => pass(g.before)),
  limitations: ['Single 100-question development-set run per arm, not held-out or repeated statistical evidence.',
    historical ? 'Historical answer baseline rescored under identical rubric; different code and sampling times. Latency is a regression observation, not simultaneous randomized A/B.' : 'Same code, same saved model settings, same concurrency=2 per arm; two isolated servers overlap in time and share providers/database.',
    'Real live data may drift from historical gold and between reads. Recall auditing can itself create records.',
    'Independent model-assisted grading, not fully human-verified answer accuracy.',
    replacement ? 'Replacement arm uses Jev routing and guarded prefetch, with additive evidence checks off; not pure model attribution.' : 'Active arm includes Jev plus deterministic field checks and supplemental-query/ranking guidance; this is not pure model attribution.',
    'Visible Jev counts cover platformRecall outputs only; absent logs do not prove zero internal calls.'],
};
fs.writeFileSync(path.join(active, rubricV2 ? 'jev-answer-ab-v2.json' : 'jev-answer-ab.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
