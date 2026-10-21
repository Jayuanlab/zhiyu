import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { checkRecallEvidence } from "../lib/memory/retrieval/jev-evidence-check.ts";

process.loadEnvFile(fileURLToPath(new URL('../.env.local', import.meta.url)));
const base = new URL('../../../.runtime/evals/platform-memory-real-100/2026-09-19T04-07-03-002Z/', import.meta.url);
const lines = async name => (await readFile(new URL(name, base), 'utf8')).trim().split('\n').map(JSON.parse);
const [gold, corpus, questions] = await Promise.all(['gold.jsonl', 'corpus.jsonl', 'questions.jsonl'].map(lines));
const byId = new Map(corpus.map(row => [row.id, row]));
const questionById = new Map(questions.map(row => [row.id, row]));
const natural = process.argv.includes('--natural');
const cases = [];
for (const row of gold) {
  if (cases.length >= 100) break;
  if (!row.expected?.facts || row.evidence.length !== 1) continue;
  const source = byId.get(row.evidence[0]);
  const fields = Object.keys(row.expected.facts);
  if (source?.kind !== 'database_row' || fields.length < 2 || !fields.every(key => Object.hasOwn(source.content, key))) continue;
  // Oracle projection uses field names only; values always come from raw corpus.
  const projection = Object.fromEntries(fields.map(key => [key, source.content[key]]));
  const question = natural
    ? `请依据 ${source.capturedAt} 的历史快照回答：${questionById.get(row.id).question}`
    : `截至 ${source.capturedAt} 的快照，记录 ${source.recordId} 的这些字段原值分别是什么：${fields.join('、')}？显式 null 可以回答为未记录；没有提供的字段不能推断。`;
  const removedField = fields.at(-1);
  for (const variant of ['complete', 'missing_field']) {
    const data = { ...projection };
    if (variant === 'missing_field') delete data[removedField];
    cases.push({ id: `${row.id}-${variant}`, originalCaseId: row.id, originalQuestion: questionById.get(row.id)?.question,
      domain: row.domain, variant, removedField: variant === 'missing_field' ? removedField : null,
      sourceHash: source.sha256, question,
      evidence: [{ id: source.id, content: JSON.stringify({ capturedAt: source.capturedAt, recordId: source.recordId, fields: data }) }],
    });
  }
}
if (!cases.length || cases.length % 2) throw new Error('Invalid paired controls');
const out = new URL(`../../../.runtime/evals/jev-memory/${new Date().toISOString().replace(/[:.]/g, '-')}/`, import.meta.url);
await mkdir(out, { recursive: true });
await writeFile(new URL('cases.json', out), JSON.stringify(cases, null, 2));
console.log(JSON.stringify({ cases: cases.length, domains: [...new Set(cases.map(item => item.domain))], folder: fileURLToPath(out) }));
const results = [];
let next = 0;
async function worker() {
  while (next < cases.length) {
    const item = cases[next++];
    // This paired experiment isolates content completeness, not historical validity.
    // Corpus capture timestamps do not establish a source-state validity interval.
    const check = await checkRecallEvidence({ ...item, timePolicy: { mode: 'unconstrained' } }, { mode: 'shadow' });
    const score = check.coverage?.length ? Math.min(...check.coverage.map(item => item.support)) : undefined;
    const decision = check.status !== 'ok' ? 'unavailable' : score >= 0.65 ? 'sufficient' : score < 0.35 ? 'insufficient' : 'uncertain';
    const result = { id: item.id, originalCaseId: item.originalCaseId, domain: item.domain, variant: item.variant, removedField: item.removedField,
      check, decision, correct: decision === (item.variant === 'complete' ? 'sufficient' : 'insufficient') };
    results.push(result);
    await writeFile(new URL(`${item.id}.json`, out), JSON.stringify(result, null, 2));
    if (results.length % 10 === 0) console.log(JSON.stringify({ completed: results.length, correct: results.filter(row => row.correct).length, unavailable: results.filter(row => row.decision === 'unavailable').length }));
  }
}
await Promise.all([worker(), worker()]);
results.sort((a, b) => a.id.localeCompare(b.id));
const distribution = rows => ({ total: rows.length, correct: rows.filter(row => row.correct).length,
  sufficient: rows.filter(row => row.decision === 'sufficient').length, insufficient: rows.filter(row => row.decision === 'insufficient').length,
  uncertain: rows.filter(row => row.decision === 'uncertain').length, unavailable: rows.filter(row => row.decision === 'unavailable').length,
  truncated: rows.filter(row => row.check.truncated).length });
const elapsed = results.map(row => row.check.elapsedMs).sort((a, b) => a - b);
const summary = { generatedAt: new Date().toISOString(), model: 'jev-1.13.0', concurrency: 2, deadlineMs: 2000,
  schemaVersion: 'evidence-atomic.v3', timeValidation: 'disabled explicitly: content-only paired controls, no historical validity claim', aggregate: 'minimum policy support across requirements; not joint probability',
  questionMode: natural ? 'original_natural_language' : 'explicit_field_names',
  methodology: `${cases.length / 2} real snapshot record projections, two controls each. ${natural ? 'Original natural-language questions with historical snapshot qualification. Labels are provisional field-omission proxies: omitted fields may not be requested or may be inferable. Agreement is NOT validated accuracy.' : 'Exact field-value questions; positives preserve all requested fields, negatives omit one.'} Tests evidence sufficiency only, not end-to-end answers or original 100-question accuracy. No retries or threshold tuning. Explicit null is a recorded value. Truncated inputs remain in total and are separately reported.`,
  casesHash: createHash('sha256').update(JSON.stringify(cases)).digest('hex'),
  total: distribution(results), complete: distribution(results.filter(row => row.variant === 'complete')),
  missingField: distribution(results.filter(row => row.variant === 'missing_field')),
  untruncated: distribution(results.filter(row => !row.check.truncated)),
  latencyMs: { median: elapsed[Math.ceil(elapsed.length * 0.5) - 1], p95: elapsed[Math.ceil(elapsed.length * 0.95) - 1], max: elapsed.at(-1) },
  usage: results.reduce((sum, row) => ({ input: sum.input + (row.check.usage?.input_tokens ?? 0), output: sum.output + (row.check.usage?.output_tokens ?? 0) }), { input: 0, output: 0 }),
  failures: results.filter(row => !row.correct).map(row => ({ id: row.id, score: row.check.coverage?.length ? Math.min(...row.check.coverage.map(item => item.support)) : undefined, decision: row.decision, removedField: row.removedField, truncated: row.check.truncated, detail: row.check.detail })),
};
await writeFile(new URL('summary.json', out), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
