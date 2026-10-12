// Explicit, resumable execution. Questions go to the model; labels remain with the judge.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { validateV2QuestionInputs } from './lib/platform-eval-v2-contract.mjs';
import { evalProviderLockPath, readEvalProviderLock, verifyEvalVersionLock } from './lib/platform-eval-v2-provider-lock.mjs';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(web, '../..');
const argument = (name) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const folderArgument = argument('folder');
if (!folderArgument) throw Error('An explicit --folder=<v2 package> is required');
const folder = path.resolve(folderArgument);
const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'manifest.json'), 'utf8'));
if (manifest.suiteVersion !== 'platform-capability-100.v2') throw Error('Unsupported suite');
const validation = spawnSync(process.execPath, [path.join(web, 'scripts/validate-platform-capability-eval-v2.mjs'), `--folder=${folder}`], { cwd: root, encoding: 'utf8', windowsHide: true });
if (validation.status !== 0) throw Error(`Package validation failed: ${validation.stdout.slice(-2000)}`);
const questionBytes = fs.readFileSync(path.join(folder, 'questions.jsonl'), 'utf8');
const questions = questionBytes.trim().split('\n').map(JSON.parse);
const inputs = validateV2QuestionInputs(questions);
if (!inputs.valid) throw Error(inputs.errors.join('; '));
const hash = value => createHash('sha256').update(value).digest('hex');
const ids = argument('ids')?.split(',');
const selected = questions.filter(question => (!ids || ids.includes(question.id))
  && (!process.argv.includes('--qa-only') || manifest.executionTracks[question.id] !== 'sandbox_workflow')
  && (!process.argv.includes('--workflow-only') || manifest.executionTracks[question.id] === 'sandbox_workflow'));
if (!selected.length || (ids && (new Set(ids).size !== ids.length || ids.some(id => !questions.some(question => question.id === id))))) throw Error('Unknown, repeated or empty case selection');
if (!process.argv.includes('--execute')) {
  console.log(JSON.stringify({ status: 'prepared_only', caseCount: selected.length, tracks: selected.reduce((result, question) => { const track = manifest.executionTracks[question.id]; result[track] = (result[track] ?? 0) + 1; return result; }, {}), modelCalls: 0, note: 'Use --execute to run the configured model.' }, null, 2));
  process.exit(0);
}
const identityUrl = process.env.MEMORY_EVAL_URL ?? 'http://127.0.0.1:3515';
const identity = await fetch(`${identityUrl}/api/identity`, { signal: AbortSignal.timeout(10000) }).then(response => { if (!response.ok) throw Error(`Identity HTTP ${response.status}`); return response.json(); });
if (identity.actorId !== manifest.ownerId) throw Error('Current owner differs from package owner');
const runArgument = argument('run-folder');
const runFolder = runArgument ? path.resolve(runArgument) : path.join(folder, `run-${new Date().toISOString().replace(/[:.]/g, '-')}`);
if (!runFolder.startsWith(folder + path.sep)) throw Error('Run folder must be inside the explicit package');
const concurrency = Math.min(4, Math.max(1, Number(argument('concurrency') ?? 3)));
const providerLockPath = evalProviderLockPath(argument('provider-lock') ?? process.env.PLATFORM_EVAL_PROVIDER_LOCK_PATH, runFolder);
const providerLock = providerLockPath ? readEvalProviderLock(providerLockPath, runFolder) : null;
if (providerLock) {
  if (providerLock.ownerId !== manifest.ownerId || providerLock.folder !== folder || concurrency !== 3) throw Error('Locked run owner/package/concurrency mismatch');
  verifyEvalVersionLock(providerLock, root);
}
const metadataFile = path.join(runFolder, 'run.json');
const resume = process.argv.includes('--resume');
const write = (name, value) => fs.writeFileSync(path.join(runFolder, name), JSON.stringify(value, null, 2) + '\n', 'utf8');
let run;
if (fs.existsSync(metadataFile)) {
  if (!resume) throw Error('Existing run requires --resume; first-attempt records are never overwritten');
  run = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
  if (run.suiteVersion !== manifest.suiteVersion || run.questionsHash !== hash(questionBytes) || run.rubricHash !== manifest.rubricHash) throw Error('Resume package or rubric drift');
  if (providerLock && run.providerLockHash !== providerLock.lockHash) throw Error('Resume provider lock mismatch');
} else {
  fs.mkdirSync(runFolder, { recursive: true });
  run = { suiteVersion: manifest.suiteVersion, startedAt: new Date().toISOString(), folder, runFolder,
    track: 'configured Pi model with guarded frozen-source tools and isolated workflow adapters; not full production Chat UI',
    questionsHash: hash(questionBytes), rubricHash: manifest.rubricHash, corpusHash: hash(fs.readFileSync(path.join(folder, 'corpus.jsonl'))),
    recordSnapshotCapturedAt: manifest.recordSnapshotCapturedAt, repositoryCapturedAt: manifest.repositoryCapturedAt,
    inputProtocol: 'raw-user-question.v2', goldInjected: false, questionLabelsInjected: false,
    selectedCases: [], caseCount: 100, productionBusinessWrites: false,
    sourcePolicy: 'Only corpus raw source data is accessible. Source adapters replace live database reads; formal guards, projections, pagination, Pi harness and configured JEV prefetch remain exercised.',
    resultsPolicy: 'Every first attempt is retained. Missing fixture and execution failures remain in the 100-case denominator.',
    concurrency, timeoutMs: 240000, hardWorkerTimeoutMs: 330000,
    runnerHash: hash(fs.readFileSync(fileURLToPath(import.meta.url))),
    ...(providerLock ? { providerLockHash: providerLock.lockHash, lockedRunManifest: path.join(runFolder, 'locked-run-manifest.json'), latestPointerUpdated: false } : {}),
  };
  for (const question of questions) write(`${question.id}.json`, { id: question.id, question: question.question,
    executionTrack: manifest.executionTracks[question.id], status: 'not_run', answer: null, events: [], toolsEnabled: false });
}
run.selectedCases = [...new Set([...run.selectedCases, ...selected.map(question => question.id)])];
run.executionPhases ??= [];
run.executionPhases.push({ startedAt: new Date().toISOString(), selectedCases: selected.map(question => question.id),
  sourceHashes: Object.fromEntries(['scripts/run-platform-capability-eval-v2.mjs', 'scripts/run-platform-capability-eval-v2-worker.mts',
    'scripts/lib/platform-eval-v2-frozen-tools.mts', 'scripts/lib/platform-eval-v2-workflows.mjs'].filter(filename => fs.existsSync(path.join(web, filename)))
    .map(filename => [filename, hash(fs.readFileSync(path.join(web, filename)))])),
  firstAttemptPolicy: 'Previously attempted cases are retained, not rerun or replaced.' });
write('run.json', run);
if (!process.argv.includes('--no-latest') && !providerLock) fs.writeFileSync(path.join(root, '.runtime/evals/platform-capability-100-v2/latest-run.json'), JSON.stringify({ folder, runFolder }, null, 2) + '\n', 'utf8');
let next = 0;
let completed = 0;
let configurationDrift = false;
async function execute(question) {
  const output = path.join(runFolder, `${question.id}.json`);
  const previous = JSON.parse(fs.readFileSync(output, 'utf8'));
  if (previous.status !== 'not_run') { completed++; console.log(JSON.stringify({ id: question.id, status: previous.status, retainedFirstAttempt: true })); return; }
  await new Promise(resolve => {
    const log = fs.openSync(path.join(runFolder, `${question.id}.log`), 'w');
    const child = spawn(process.execPath, ['--import', 'tsx', '--conditions=react-server', 'scripts/run-platform-capability-eval-v2-worker.mts', folder, runFolder, question.id], { cwd: web, windowsHide: true, stdio: ['ignore', log, log], env: { ...process.env, ...(providerLockPath ? { PLATFORM_EVAL_PROVIDER_LOCK_PATH: providerLockPath } : {}) } });
    let expired = false;
    const timer = setTimeout(() => { expired = true; child.kill(); }, run.hardWorkerTimeoutMs);
    child.on('error', error => { clearTimeout(timer); fs.closeSync(log); write(`${question.id}.json`, { ...previous, status: 'worker_failed', error: String(error), finishedAt: new Date().toISOString() }); completed++; resolve(); });
    child.on('exit', code => {
      clearTimeout(timer); fs.closeSync(log);
      let result = JSON.parse(fs.readFileSync(output, 'utf8'));
      if (expired || ['running', 'not_run'].includes(result.status)) {
        result = { ...result, status: expired ? 'timeout' : 'worker_failed', exitCode: code, finishedAt: new Date().toISOString() };
        write(`${question.id}.json`, result);
      }
      completed++;
      if (providerLock && result.failureStage === 'configuration_lock') configurationDrift = true;
      console.log(JSON.stringify({ completed, selected: selected.length, id: question.id, status: result.status, toolCalls: result.toolCalls?.length ?? 0, ms: result.ms }));
      resolve();
    });
  });
}
await Promise.all(Array.from({ length: Math.min(concurrency, selected.length) }, async () => { while (!configurationDrift && next < selected.length) await execute(selected[next++]); }));
const rows = questions.map(question => JSON.parse(fs.readFileSync(path.join(runFolder, `${question.id}.json`), 'utf8')));
run.updatedAt = new Date().toISOString();
run.statuses = rows.reduce((counts, row) => { counts[row.status] = (counts[row.status] ?? 0) + 1; return counts; }, {});
run.finishedAt = rows.every(row => row.status !== 'not_run') ? run.updatedAt : null;
if (configurationDrift) { run.failureStage = 'configuration_lock'; run.executionStopped = true; process.exitCode = 1; }
write('run.json', run);
write('execution-summary.json', { suiteVersion: manifest.suiteVersion, runFolder, caseCount: 100, selectedCaseCount: selected.length, statuses: run.statuses, evaluation: 'answers and receipts captured; independent scoring is separate' });
console.log(JSON.stringify({ finished: true, runFolder, statuses: run.statuses }));
