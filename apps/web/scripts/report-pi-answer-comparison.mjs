import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const [baseline, candidate] = process.argv.slice(2).map(p => path.resolve(p));
if (!baseline || !candidate) throw Error('Usage: report-pi-answer-comparison.mjs <baseline> <candidate>');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const complete = grade => ['complete', 'boundary_pass'].includes(grade.outcome);
function load(folder) {
  const grades = read(path.join(folder, 'pi-answer-judge/grades.json'));
  const summary = read(path.join(folder, 'pi-answer-judge/summary.json'));
  if (grades.length !== 100 || new Set(grades.map(g => g.id)).size !== 100) throw Error('Requires all 100 grades');
  const records = grades.map(g => read(path.join(folder, `${g.id}.json`)));
  return { summary, grades, records };
}
const before = load(baseline), after = load(candidate);
const beforeById = new Map(before.grades.map(g => [g.id, g]));
const metrics = run => ({
  total: 100,
  completed: run.records.filter(r => r.status === 'completed').length,
  sufficient: run.grades.filter(complete).length,
  partial: run.grades.filter(g => g.outcome === 'partial').length,
  incorrect: run.grades.filter(g => g.outcome === 'incorrect').length,
  insufficient: run.grades.filter(g => g.outcome === 'insufficient').length,
  boundaryPass: run.grades.filter(g => g.outcome === 'boundary_pass').length,
  factualComplete: run.grades.filter(g => g.outcome === 'complete').length,
  factualTotal: 95,
});
const report = {
  at: new Date().toISOString(), baseline, candidate,
  before: metrics(before), after: metrics(after),
  improvedToSufficient: after.grades.filter(g => complete(g) && !complete(beforeById.get(g.id))).map(g => g.id),
  regressedFromSufficient: after.grades.filter(g => !complete(g) && complete(beforeById.get(g.id))).map(g => ({ id: g.id, reason: g.reason })),
  remaining: after.grades.filter(g => !complete(g)),
  candidateFailures: after.records.filter(r => r.status !== 'completed').map(r => ({ id: r.id, status: r.status, errors: r.events.filter(e => e.type === 'error').map(e => e.message) })),
  limitations: [
    'Model-assisted grading; not a human-verified gold verdict.',
    'Development benchmark, not held-out generalization accuracy.',
    'Live records can drift from historical expected answers.',
    'Candidate concurrency=2; baseline concurrency=1. Completion changes are not a controlled latency experiment.',
    'Sufficient includes correct boundary handling; factualComplete/factualTotal excludes the five boundary cases.',
  ],
  sourceHashes: Object.fromEntries(['platform-recall.ts', 'platform-record-reader.ts', 'platform-statistics.ts', 'native-pi-web-chat-tools.ts'].map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(root, 'apps/web/lib/ai', file))).digest('hex')])),
};
fs.writeFileSync(path.join(candidate, 'answer-comparison.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
