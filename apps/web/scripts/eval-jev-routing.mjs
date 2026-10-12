import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { routeRecallWithJev } from '../lib/brain/jev-recall-router.ts';
import { routingMetrics } from './lib/jev-routing-metrics.mjs';

// Usage: node --import tsx scripts/eval-jev-routing.mjs [--cases=path.json]
// Labels never reach the model. This changes only this process's environment.
const webRoot = fileURLToPath(new URL('../', import.meta.url));
process.loadEnvFile(path.join(webRoot, '.env.local'));
process.env.BRAIN_JEV_ROUTING = 'replace';
const casesPath = process.argv.find(a => a.startsWith('--cases='))?.slice(8);
const cases = JSON.parse(fs.readFileSync(casesPath ?? new URL('./fixtures/jev-routing-smoke.json', import.meta.url), 'utf8'));
const validSources = new Set(['architecture', 'records', 'knowledge', 'brain']);
if (!Array.isArray(cases) || !cases.length || cases.some(c => typeof c.question !== 'string' || !c.question.trim()
  || (c.expectedSources !== undefined && (!Array.isArray(c.expectedSources) || c.expectedSources.some(s => !validSources.has(s)))))) throw Error('Invalid cases');
const out = path.resolve(webRoot, '../../.runtime/evals/jev-routing', new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(out, { recursive: true });
const rows = [];
for (const item of cases) {
  const result = await routeRecallWithJev(item.question, undefined, { enabled: true });
  rows.push({ id: item.id, split: item.split, question: item.question, expectedSources: item.expectedSources, result });
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(rows, null, 2), 'utf8');
}
const report = { generatedAt: new Date().toISOString(), inputProtocol: 'raw-user-question.v2',
  labelOrigin: casesPath ? 'caller-supplied; not independently verified' : 'synthetic smoke labels; not held-out validation',
  sourceHash: createHash('sha256').update(fs.readFileSync(new URL('../lib/brain/jev-recall-router.ts', import.meta.url))).digest('hex'),
  metrics: routingMetrics(rows) };
fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify({ out, total: rows.length, accepted: report.metrics.accepted, degraded: report.metrics.degraded,
  acceptedExactAccuracy: report.metrics.acceptedExactAccuracy }));
if (rows.some(r => r.result.status !== 'ok' && r.result.detail !== 'uncertain_route')) process.exitCode = 1;
