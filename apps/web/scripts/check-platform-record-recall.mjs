import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'dotenv';
for (const file of ['../../.env', '.env', '.env.local']) {
  if (fs.existsSync(file)) for (const [key, value] of Object.entries(parse(fs.readFileSync(file)))) {
    if (!(key in process.env)) process.env[key] = value;
  }
}
const { readPlatformRecordsForOwner } = await import('../lib/ai/platform-record-reader.ts');
const { readPlatformStatisticsForOwner } = await import('../lib/ai/platform-statistics.ts');
const base = path.resolve('../../.runtime/evals/platform-memory-real-100');
const { folder } = JSON.parse(fs.readFileSync(path.join(base, 'latest.json'), 'utf8'));
// Questions only. No expected answers or captured corpus enter retrieval.
const questions = fs.readFileSync(path.join(folder, 'questions.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const { actorId } = await fetch('http://127.0.0.1:3515/api/identity').then(r => r.json());
if (!actorId) throw Error('Missing owner');
const results = [];
const namedQuestion = questions[0].question.replace(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/gi, '');
const namedRecall = await readPlatformRecordsForOwner({ userId: actorId, question: namedQuestion });
if (!namedRecall.records.some(r => r.source === 'workshops') || namedRecall.failedSources.length) throw Error('Named entity recall failed');
for (const question of questions) {
  const result = await readPlatformRecordsForOwner({ userId: actorId, question: question.question });
  if (!result.requestedIds.length) continue;
  results.push({ id: question.id, matched: result.requestedIds.length - result.missingIds.length, sources: result.records.map(r => r.source), failures: result.failedSources });
}
const foreign = await readPlatformRecordsForOwner({ userId: '00000000-0000-0000-0000-000000000000', question: questions[0].question });
if (foreign.records.length) throw Error('Owner isolation failed');
for (const id of ['REAL-007', 'REAL-043', 'REAL-059', 'REAL-060']) {
  const question = questions.find(q => q.id === id);
  const denied = await readPlatformRecordsForOwner({ userId: '00000000-0000-0000-0000-000000000000', question: question.question });
  if (denied.records.length || denied.failedSources.length) throw Error(`Foreign-owner check failed: ${id}`);
}
const foreignStatistics = await readPlatformStatisticsForOwner({ userId: '00000000-0000-0000-0000-000000000000' });
if (foreignStatistics.results.some(r => r.status !== 'ok' || r.total !== 0)) throw Error('Aggregate isolation failed');
const statistics = await readPlatformStatisticsForOwner({ userId: actorId });
const report = { at: new Date().toISOString(), total: results.length, matched: results.filter(r => r.matched > 0).length, sourceFailures: [...new Set(results.flatMap(r => r.failures))], foreignOwnerRecords: foreign.records.length, namedEntityCheck: 'passed', foreignParentAndAggregateChecks: 'passed', statistics, results };
const output = path.join(base, 'platform-record-check.json');
fs.writeFileSync(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
process.exit(report.sourceFailures.length || statistics.results.some(r => r.status !== 'ok') ? 1 : 0);
