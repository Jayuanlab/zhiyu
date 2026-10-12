// Read-only comparison preflight. This program never constructs a model or DB client.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { directLoopRuntimeQuestionId } from '../lib/ai/loop-runtime-answer-guard';
import { exactCurrentLoopEvidenceSubject } from '../lib/ai/runtime/answer-evidence-session';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(web, '../..');
const option = (name: string) => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const read = (filename: string) => JSON.parse(fs.readFileSync(filename, 'utf8'));
const folderArg = option('folder'), runArg = option('original-run'), outArg = option('out');
if (!folderArg || !runArg || !outArg) throw Error('Explicit --folder, --original-run and --out are required');
const folder = path.resolve(folderArg), originalRun = path.resolve(runArg), out = path.resolve(outArg);
const evidenceRoot = path.join(root, '.runtime', 'evals', 'platform-capability-100-v2');
if (!folder.startsWith(evidenceRoot + path.sep) || !originalRun.startsWith(folder + path.sep)
  || !out.startsWith(evidenceRoot + path.sep) || fs.existsSync(out)) throw Error('Fresh private comparison output and explicit frozen package required');
const manifest = read(path.join(folder, 'manifest.json'));
const run = read(path.join(originalRun, 'run.json'));
if (manifest.suiteVersion !== 'platform-capability-100.v2' || run.suiteVersion !== manifest.suiteVersion) throw Error('Comparison suite mismatch');
const packageHashes = Object.fromEntries(['questions.jsonl', 'corpus.jsonl', 'rubric.json'].filter(name => fs.existsSync(path.join(folder, name)))
  .map(name => [name, digest(fs.readFileSync(path.join(folder, name)))]));
if (packageHashes['questions.jsonl'] !== run.questionsHash || packageHashes['corpus.jsonl'] !== run.corpusHash
  || manifest.rubricHash !== run.rubricHash) throw Error('Original frozen inputs drifted');
const questions: any[] = fs.readFileSync(path.join(folder, 'questions.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
if (questions.length !== 100 || questions.some(question => !/^REAL-(?:0\d{2}|100)$/.test(question.id))) throw Error('Expected the unchanged original 100 inputs');

function currentHash(filename: string) {
  const normalized = filename.replaceAll('\\', '/').replace(/^apps\/web\//, '');
  const absolute = path.resolve(web, normalized);
  if (!absolute.startsWith(web + path.sep) || /(?:^|\/)\.env(?:\.|$)/.test(normalized)) throw Error('Unsafe recorded source path');
  return fs.existsSync(absolute) ? digest(fs.readFileSync(absolute)) : null;
}
function compareRecorded(hashes: Record<string, string> | undefined) {
  return Object.entries(hashes ?? {}).map(([file, originalHash]) => ({ file, originalHash, currentHash: currentHash(file) }))
    .map(row => ({ ...row, changed: row.currentHash !== row.originalHash }));
}
const rows = questions.map(question => {
  const record = read(path.join(originalRun, `${question.id}.json`));
  if (record.id !== question.id || record.question !== question.question) throw Error('Original question/record mismatch');
  const isolationFile = path.join(originalRun, 'fixtures', question.id, 'isolation.json');
  const isolation = fs.existsSync(isolationFile) ? read(isolationFile) : undefined;
  const sources = compareRecorded(record.metadata?.sourceHashes);
  const fixtureSources = compareRecorded(isolation?.loadedSourceHashes);
  return {
    id: question.id, executionTrack: record.executionTrack, originalStatus: record.status,
    originalRecordHash: digest(fs.readFileSync(path.join(originalRun, `${question.id}.json`))),
    inputQuestionHash: digest(question.question), model: record.metadata?.model ?? null,
    protocol: record.metadata?.protocol ?? null, originalAllowedTools: record.metadata?.allowedTools ?? [],
    legacyGuardQuestionEligible: Boolean(directLoopRuntimeQuestionId(question.question)),
    evidenceGateQuestionEligible: Boolean(exactCurrentLoopEvidenceSubject(question.question)),
    originalWorkerSourceHashesPresent: sources.length > 0, originalFixtureSourceHashesPresent: fixtureSources.length > 0,
    sourceContinuity: sources, fixtureSourceContinuity: fixtureSources,
    originalModelAnswerRetained: true,
    comparisonClassification: 'historical_reference_not_strict_matched_baseline',
  };
});
const qa = rows.filter(row => row.executionTrack !== 'sandbox_workflow');
const workflows = rows.filter(row => row.executionTrack === 'sandbox_workflow');
const count = (values: any[], key: string) => values.reduce((result, row) => ({ ...result, [row[key]]: (result[row[key]] ?? 0) + 1 }), {} as Record<string, number>);
const selectedWebFiles = [
  'scripts/run-platform-capability-eval-v2.mjs', 'scripts/run-platform-capability-eval-v2-worker.mts',
  'scripts/lib/platform-eval-v2-frozen-tools.mts', 'scripts/lib/platform-eval-v2-workflows.mjs',
  'scripts/lib/platform-eval-v2-workflow-worker.mts', 'scripts/lib/platform-eval-v2-http-server.mjs',
  'app/api/native/agent/route.ts', 'lib/ai/runtime/answer-evidence-session.ts', 'lib/ai/runtime/answer-evidence-contract.ts',
  'lib/ai/runtime/tool-executor.ts', 'lib/ai/runtime/pi-tool-adapter.ts', 'lib/ai/native-pi-web-chat-tools.ts',
  'lib/ai/loop-runtime-answer-guard.ts', 'lib/db/agent-answer-audits.ts',
];
const selectedPackageFiles = ['packages/ai/src/agent/runtime/index.ts', 'packages/ai/src/agent/runtime/pi-harness-adapter.ts',
  'packages/ai/src/agent/runtime/pi-model-config.ts', 'packages/ai/src/agent/runtime/types.ts', 'pnpm-lock.yaml'];
const candidateSourceSnapshot = Object.fromEntries([
  ...selectedWebFiles.map(file => [`apps/web/${file}`, currentHash(file)]),
  ...selectedPackageFiles.map(file => [file, digest(fs.readFileSync(path.join(root, file)))]),
]);
const worker = fs.readFileSync(path.join(web, 'scripts/run-platform-capability-eval-v2-worker.mts'), 'utf8');
const workerHasEvidenceSessionIntegration = /createAnswerEvidenceSession|answerEvidenceSession|answer-evidence-session/.test(worker);
const workerHasNativeHttpIntegration = /\/api\/native\/agent/.test(worker);
const plan = {
  schemaVersion: 'platform-capability-comparison-preflight.v1', generatedAt: new Date().toISOString(),
  purpose: 'readonly_protocol_and_source_continuity_audit', modelCalls: 0, productionWrites: 0,
  original: { suiteVersion: manifest.suiteVersion, folder, runFolder: originalRun,
    runMetadataHash: digest(fs.readFileSync(path.join(originalRun, 'run.json'))), packageHashes,
    rubricHash: run.rubricHash, recordSnapshotCapturedAt: manifest.recordSnapshotCapturedAt,
    repositoryCapturedAt: manifest.repositoryCapturedAt, models: [...new Set(rows.map(row => row.model))],
    protocols: [...new Set(rows.map(row => row.protocol))], counts: { total: rows.length, qa: qa.length, workflows: workflows.length },
    missingQaWorkerSourceHashes: qa.filter(row => !row.originalWorkerSourceHashesPresent).map(row => row.id),
    originalStatuses: count(rows, 'originalStatus'),
  },
  candidateSourceSnapshot,
  nativeGateCoverage: {
    canonicalPredicate: 'exactCurrentLoopEvidenceSubject',
    legacyGuardEligibleIds: rows.filter(row => row.legacyGuardQuestionEligible).map(row => row.id),
    evidenceGateEligibleIds: rows.filter(row => row.evidenceGateQuestionEligible).map(row => row.id),
    workerHasEvidenceSessionIntegration, workerHasNativeHttpIntegration,
    original100WorkerGateActuallyLoaded: false,
    semanticEligibilityDoesNotProveRuntimeLoading: true,
    frozenQaRuntimeObservation: 'source_unavailable_frozen_capture_not_fresh_execution_lease_observation',
    workflow094ToolsAreNotSessionPlatformRecall: true,
  },
  comparisonPolicy: {
    original100: 'Keep original 100 denominator, questions, rubric, input corpus and first-attempt files immutable. New output folder only.',
    historicalDelta: 'Descriptive regression against the original run, not causal evidence for answer gate or JEV accuracy.',
    candidateRegression: '90 QA and 10 workflows separately; all timeouts, provider errors, fixture errors, denied and unknown remain visible.',
    qa: 'Report record_qa 67 and source_qa 23 separately. Frozen source facts are not current production state. Same model/protocol/budgets/JEV settings and corpus pinned.',
    workflow: 'Separate service/effect checks, answer judgments and fixture validity. 071 adapter availability and 085 premise repairs are fixture corrections, not model capability gains.',
    newMatchedGate: 'A separate exact-Loop read-only native endpoint experiment: same case, fixture state, provider/model/tools/prompt/budget; explicit off versus enforce_critical in isolated servers. Preserve both raw draft and delivered answer.',
    gateControls: 'No production flag switch for an experiment. Replay idempotency and errors are control checks, not successful model answers.',
    mixedGoals: 'Original compound history/recovery/action questions retain authored criteria. Do not alter them to make a narrow gate eligible.',
    inference: 'Unknown remains unknown; no mapping or paused configuration alone cannot prove target execution stopped.',
  },
  requiredCandidateInstrumentation: [
    'Exact package/corpus/rubric hashes plus all fixture definitions and semantic initial-state hashes before any model call.',
    'Loaded provider/model/protocol and actual runtime/tool-schema hashes; resolved runtime entry and dependency lock hash.',
    'Declared mode, eligible/ineligible reason, requested intent hash, actual loaded hash and audited runtime_loaded event for a native gate case.',
    'Raw SDK tool-visible text hash, tool construction and delivery receipts with matching call ids, emitted evidence refs, raw draft and final delivered text.',
    'Explicit real runtime terminal and cleanup status; separate answer_delivery failure and runtimeStatus.',
    'Source hash drift aborts or marks the affected case; never continue a matched pair with unknown code versions.',
    'One fresh first attempt per case/arm in separate folders; no best-of retries. Repeated sampling, if chosen, has fixed repeats and all attempts reported.',
    'Blind answer judging uses the same authored rubric and identical receipt protocol; evidence audit can reject unsupported auxiliary labels without overwriting them.',
  ],
  minimalScriptChanges: [
    { script: 'run-platform-capability-eval-v2.mjs', change: 'Accept a fresh explicit comparison run folder and persist a comparison manifest/hash before execution; retain resume only for not_run cases.' },
    { script: 'run-platform-capability-eval-v2-worker.mts', change: 'Instrument actual runtime entry/tool schemas/prompt/gateApplicability. Existing harness remains the original100 regression track; do not label flag-only runs as gate-loaded.' },
    { script: 'separate native comparison runner', change: 'Use an isolated DB/HTTP server and formal /api/native/agent with saved owner user message/assistant ids. Keep the production 3515 service observational; synthetic side effects stay in test DB/FS/provider.' },
    { script: 'separate comparison reporter', change: 'Join results by REAL id and explicit arm, preserve original auxiliary and independent adjudications, show fixture/source continuity and uncertainty before score deltas.' },
  ],
  rows,
};
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(plan, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
console.log(JSON.stringify({ status: 'prepared_only', modelCalls: 0, output: out,
  cases: rows.length, qa: qa.length, workflows: workflows.length,
  eligibleOriginalQuestions: plan.nativeGateCoverage.evidenceGateEligibleIds,
  workerHasEvidenceSessionIntegration, workerHasNativeHttpIntegration }));
