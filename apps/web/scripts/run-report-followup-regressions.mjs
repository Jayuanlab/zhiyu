// Keep the matched research suite and add the bounded seams changed by a review.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const directory = '../../docs/verification/artifacts/deepseek-report-rerun-2026-10-09/';
const review = process.argv[2] ?? '54';
assert(['54', '55', '56', '57'].includes(review));
const baseline = JSON.parse(readFileSync(directory + 'targeted-regression-review53-final.json', 'utf8'));
const tests = [...new Set([...baseline.testResults.map(result => {
  const name = result.name.replaceAll('\\', '/').split('/tests/unit/')[1];
  assert.match(name, /^[a-z0-9-]+\.test\.ts$/);
  return 'tests/unit/' + name;
}), 'tests/unit/workshop-research-reading-progress.test.ts', 'tests/unit/workshop-pi-host-error-propagation.test.ts'])];
assert.equal(tests.length, 32);
if (review === '56' || review === '57') tests.push(...[
  'tests/unit/direct-defuddle-page-reader.test.ts', 'tests/unit/jina-page-reader.test.ts',
  'tests/unit/native-jina-page-tool.test.ts', 'tests/unit/web-figure-reader.test.ts',
  'tests/unit/chat-canonical-conversation.test.ts',
]);
if (review === '57') tests.push(...[
  'tests/unit/workshop-grounded-research-claim-scope.test.ts',
  'tests/unit/research-report-observation.test.ts',
]);
assert.equal(new Set(tests).size, tests.length);
const result = spawnSync(process.execPath, ['./scripts/run-cross-env.cjs', 'pnpm', 'exec', 'vitest', 'run',
  ...tests, '--reporter=json', '--outputFile=' + directory + 'targeted-regression-review' + review + '-final.json'],
{ stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
