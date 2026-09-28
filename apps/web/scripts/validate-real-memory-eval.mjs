import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const base = path.join(root, '.runtime/evals/platform-memory-real-100');
const folder = process.argv.find(a => a.startsWith('--folder='))?.slice(9)
  ?? JSON.parse(fs.readFileSync(path.join(base, 'latest.json'), 'utf8')).folder;
const read = name => fs.readFileSync(path.join(folder, name), 'utf8');
const json = name => JSON.parse(read(name));
const jsonl = name => read(name).trim().split('\n').filter(Boolean).map(s => JSON.parse(s));
const sha = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const equal = (a, b) => {
  try { assert.deepStrictEqual(a, b); return true; } catch { return false; }
};
const data = { manifest: json('manifest.json'), cases: json('cases.json'), docs: jsonl('corpus.jsonl'),
  questions: jsonl('questions.jsonl'), gold: jsonl('gold.jsonl'), results: jsonl('results-template.jsonl'),
  snapshot: json('snapshot.json'), coverage: json('coverage.json') };

function validate(d) {
  const errors = [];
  const check = (ok, message) => { if (!ok) errors.push(message); };
  const docById = new Map(d.docs.map(doc => [doc.id, doc]));
  check(d.cases.length === 100 && new Set(d.cases.map(c => c.id)).size === 100, 'case IDs/count');
  check(new Set(d.cases.map(c => c.question)).size === 100, 'duplicate question');
  check(docById.size === d.docs.length, 'duplicate evidence ID');
  check(d.questions.length === 100 && d.gold.length === 100 && d.results.length === 100, 'split counts');
  check(d.coverage.length === d.manifest.inventoriedTables, 'coverage inventory');
  check(Object.keys(d.snapshot.sources).length === d.manifest.sourceTables, 'source count');
  check(d.snapshot.ownerId === d.manifest.ownerId, 'snapshot owner mismatch');
  check(d.snapshot.capturedAt === d.manifest.capturedAt, 'snapshot time mismatch');
  check(d.manifest.performanceStatus === 'not_run', 'unearned performance claim');
  const requiredPlatformRecallCases = d.cases.filter(c => c.evalRequirements?.requiredTools?.includes('platformRecall'));
  check(d.manifest.platformRecallRequiredCaseCount === requiredPlatformRecallCases.length, 'platform recall requirement count');
  for (const doc of d.docs) {
    check(doc.sha256 === sha(doc.content), `hash: ${doc.id}`);
    check(doc.ownerId === d.manifest.ownerId, `owner: ${doc.id}`);
    check(doc.capturedAt === d.manifest.capturedAt, `time: ${doc.id}`);
    if (doc.kind === 'database_aggregate') {
      check(doc.parameters?.[0] === d.manifest.ownerId, `aggregate owner: ${doc.id}`);
      check(/^SELECT\b/i.test(doc.query) && doc.query.includes('$1'), `aggregate SQL: ${doc.id}`);
      if (doc.content.groups) check(doc.content.groups.reduce((n, g) => n + g.count, 0) === doc.content.total, `aggregate sum: ${doc.id}`);
    }
  }
  for (const [table, source] of Object.entries(d.snapshot.sources)) {
    check(source.parameters[0] === d.manifest.ownerId, `source owner: ${table}`);
    check(/^SELECT\b/i.test(source.query) && source.query.includes('$1'), `source SQL: ${table}`);
    check(source.total >= source.rows.length && source.rows.length <= 200, `source sample: ${table}`);
    check(!/api_key_encrypted|encryption_key_id/.test(source.query), `secret selected: ${table}`);
  }
  const subset = (expected, actual, id) => {
    for (const [field, value] of Object.entries(expected)) check(equal(value, actual?.[field]), `unsupported fact ${id}.${field}`);
  };
  for (const c of d.cases) {
    check(c.executionStatus === 'not_run', `case marked run: ${c.id}`);
    check(c.asOf === d.manifest.capturedAt && c.requester.userId === d.manifest.ownerId, `case scope: ${c.id}`);
    const evidence = c.evidence.map(id => docById.get(id));
    check(evidence.length > 0 && evidence.every(Boolean), `missing evidence: ${c.id}`);
    if (!evidence.every(Boolean)) continue;
    if (c.expected.facts) subset(c.expected.facts, evidence[0].content, c.id);
    if (c.category === '跨来源追溯') {
      subset(c.expected.left, evidence[0].content, c.id);
      subset(c.expected.right, evidence[1].content, c.id);
      const { leftKey, rightKey } = c.expected.relationship;
      check(evidence[0].content[leftKey] === evidence[1].content[rightKey], `broken join ${c.id}`);
      if (evidence[0].table === 'paper_fills') check(evidence[0].content.account_id === evidence[1].content.account_id, `paper account join ${c.id}`);
    }
    if (c.category === '全量统计') check(equal(c.expected, evidence[0].content), `aggregate answer ${c.id}`);
    if (c.locator) check(evidence[0].content.includes(c.locator.anchor), `source anchor ${c.id}`);
    const question = d.questions.find(q => q.id === c.id);
    const gold = d.gold.find(g => g.id === c.id);
    check(question?.question === c.question && !('expected' in (question ?? {})) && !('evidence' in (question ?? {})), `input separation ${c.id}`);
    check(equal(gold?.expected, c.expected) && equal(gold?.evidence, c.evidence), `gold separation ${c.id}`);
    check(equal(question?.evalRequirements, c.evalRequirements) && equal(gold?.evalRequirements, c.evalRequirements), `eval requirements separation ${c.id}`);
    if (c.evalRequirements?.requiredTools?.includes('platformRecall')) {
      check(Array.isArray(c.evalRequirements.platformRecallSections) && c.evalRequirements.platformRecallSections.length > 0, `platform recall sections ${c.id}`);
    }
    check(d.results.find(r => r.id === c.id)?.status === 'not_run', `result template ${c.id}`);
    check(!/\uFFFD|\?{3}/.test(c.question), `question encoding ${c.id}`);
  }
  return errors;
}
const errors = validate(data);
for (const [name, hash] of Object.entries(json('integrity.json'))) {
  if (sha(read(name)) !== hash) errors.push(`file integrity: ${name}`);
}
let negativeChecks = 0;
if (!errors.length && process.argv.includes('--self-test')) {
  const corruptions = [
    d => { d.cases.pop(); },
    d => { d.cases[0].evidence = ['missing']; },
    d => { d.cases[0].expected.facts.status = 'fabricated_success'; },
    d => { d.docs[0].content = { forged: true }; },
    d => { d.docs[0].ownerId = 'another-user'; },
    d => { d.questions[0].expected = 'leaked answer'; },
    d => { d.snapshot.sources.workshops.parameters = ['another-user']; },
    d => { d.manifest.performanceStatus = 'passed'; },
    d => {
      const idx = d.cases.findIndex(c => c.evalRequirements?.requiredTools?.includes('platformRecall'));
      d.questions[idx].evalRequirements.requiredTools = [];
    },
  ];
  for (const corrupt of corruptions) {
    const clone = structuredClone(data); corrupt(clone);
    assert(validate(clone).length > 0, 'Validator accepted intentionally corrupted data');
    negativeChecks++;
  }
}
const report = { status: errors.length ? 'failed' : 'passed', checks: 'dataset-integrity-and-groundtruth-only',
  capturedAt: data.manifest.capturedAt, caseCount: data.cases.length, evidenceDocuments: data.docs.length,
  tables: data.manifest.sourceTables, negativeChecks, errors, retrievalEvaluation: 'not_run' };
fs.writeFileSync(path.join(folder, 'validation.json'), JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify(report, null, 2));
if (errors.length) process.exitCode = 1;
