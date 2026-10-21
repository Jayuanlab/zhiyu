import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { checkRecallEvidence } from "../lib/memory/retrieval/jev-evidence-check.ts";

process.loadEnvFile(fileURLToPath(new URL('../.env.local', import.meta.url)));
const sourcePath = new URL('../lib/memory/retrieval/query-retry.ts', import.meta.url);
const source = await readFile(sourcePath, 'utf8');
const start = source.indexOf('const alternative =');
const evidence = [{ id: 'query-retry.ts', content: source.slice(start, source.indexOf('if (insufficient &&', start)) }];
const cases = [
  { id: 'source-supported', question: 'When the second recall runs, are the original plan fields preserved except for searchTerms and queryRetry?', expected: 'supported' },
  { id: 'source-missing', question: 'What is the current production database row count?', expected: 'unsupported' },
];
const results = [];
for (const item of cases) {
  const check = await checkRecallEvidence({ question: item.question, evidence }, { mode: 'shadow' });
  const score = check.coverage?.length ? Math.min(...check.coverage.map(item => item.support)) : undefined;
  results.push({ ...item, check, passed: check.status === 'ok' && typeof score === 'number' && (item.expected === 'supported' ? score >= 0.65 : score < 0.35) });
}
const report = { generatedAt: new Date().toISOString(), source: 'apps/web/lib/memory/retrieval/query-retry.ts', results };
const folder = new URL('../../../.runtime/evals/jev-memory/', import.meta.url);
await mkdir(folder, { recursive: true });
await writeFile(new URL('smoke.json', folder), JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify(report, null, 2));
if (results.some(result => !result.passed)) process.exitCode = 1;
