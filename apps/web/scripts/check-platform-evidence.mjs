import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'dotenv';
for (const file of ['../../.env', '.env', '.env.local']) if (fs.existsSync(file)) {
  for (const [k,v] of Object.entries(parse(fs.readFileSync(file)))) if (!(k in process.env)) process.env[k] = v;
}
const { readPlatformRecordsForOwner } = await import('../lib/ai/platform-record-reader.ts');
const { readPlatformStatisticsForOwner } = await import('../lib/ai/platform-statistics.ts');
const base = '../../.runtime/evals/platform-memory-real-100';
const folder = JSON.parse(fs.readFileSync(path.join(base, 'latest.json'))).folder;
const owner = JSON.parse(fs.readFileSync(path.join(folder, 'manifest.json'))).ownerId;
const testCase = JSON.parse(fs.readFileSync(path.join(folder, 'cases.json'))).find(c => c.domain === 'paper_fills+paper_orders');
const result = await readPlatformRecordsForOwner({ userId: owner, question: testCase.question });
if (result.failedSources.length || !result.records.some(r => r.source === 'paper_fills' && r.fields.order_id && r.fields.order_quantity)) throw Error('Live composite evidence missing');
const denied = await readPlatformRecordsForOwner({ userId: '00000000-0000-4000-8000-000000000000', question: testCase.question });
if (denied.failedSources.length || denied.records.length) throw Error('Wrong-owner read failed isolation check');
const stats = await readPlatformStatisticsForOwner({ userId: owner });
for (const source of ['paper_accounts.version', 'paper_orders.status', 'workshop_heartbeats.scheduler_status']) {
  if (!stats.results.some(r => r.source === source && r.status === 'ok')) throw Error('Live statistics unavailable: ' + source);
}
const report = { at: new Date().toISOString(), compositeRead: 'passed', sameAccountOrder: 'SQL join enforced', wrongOwner: 'empty', statistics: stats.results.filter(r => /paper_|heartbeats/.test(r.source)) };
const output = '../../.runtime/evals/jev-evidence-repair-check.json';
fs.writeFileSync(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
process.exit(0);
