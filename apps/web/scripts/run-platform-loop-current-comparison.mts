// Supplementary real HTTP experiment. Default is prepare-only, never model execution.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { parse } from 'dotenv';
import postgres from 'postgres';
import { createLoopCurrentCases, LOOP_CURRENT_COMPARISON_PROTOCOL } from './lib/platform-loop-current-comparison-cases.mjs';
import { startLoopCurrentHttp, parseLoopCurrentDatabaseUrl, parseLoopCurrentAdminUrl } from './lib/platform-loop-current-comparison-http.mjs';
import { startLoopCurrentProviderProxy } from './lib/platform-loop-current-comparison-proxy.mjs';
import { parseNativeSse, inspectNativePairArm } from './lib/platform-loop-current-comparison-receipts.mjs';
import { exactCurrentLoopEvidenceSubject } from '../lib/ai/runtime/answer-evidence-session';
import { readSavedEvalProvider, assertExpectedEvalProvider, closeEvalProviderDatabase, normalizeEvalEndpoint, configurationHash } from './lib/platform-eval-v2-provider-lock.mjs';
import { verifyEvalSourceWorkspace } from './lib/platform-eval-v2-source-workspace.mjs';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), root = path.resolve(web, '../..');
const arg = (name: string) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const jsonHash = (value: unknown) => hash(JSON.stringify(value));
const outArg = arg('out'), originalArg = arg('original-run'), sourceWorkspaceArg = arg('source-workspace');
if (!outArg || !originalArg || !sourceWorkspaceArg) throw Error('Explicit --out, --original-run and --source-workspace provenance are required');
const output = path.resolve(outArg), originalRun = path.resolve(originalArg);
const permittedOutput = path.join(root, '.runtime', 'evals', 'platform-loop-current-matched');
if (!output.startsWith(permittedOutput + path.sep) || !originalRun.startsWith(path.join(root, '.runtime', 'evals', 'platform-capability-100-v2') + path.sep)) throw Error('Explicit private output scopes required');
const cases = createLoopCurrentCases();
for (const item of cases) if (exactCurrentLoopEvidenceSubject(item.question) !== item.ids.loopId) throw Error(`Unscoped supplementary case: ${item.id}`);
const sourceFiles = ['apps/web/scripts/run-platform-loop-current-comparison.mts',
  'apps/web/scripts/lib/platform-loop-current-comparison-cases.mjs', 'apps/web/scripts/lib/platform-loop-current-comparison-http.mjs',
  'apps/web/scripts/lib/platform-loop-current-comparison-proxy.mjs', 'apps/web/scripts/lib/platform-loop-current-comparison-receipts.mjs',
  'apps/web/scripts/lib/platform-loop-current-comparison-fetch-observer.mjs',
  'apps/web/scripts/lib/platform-eval-v2-provider-lock.mjs',
  'apps/web/scripts/lib/platform-eval-v2-source-workspace.mjs',
  'apps/web/next.config.js', 'apps/web/instrumentation.ts', 'apps/web/scripts/start-local-development.mjs',
  'apps/web/scripts/auth-bind-policy.mjs', 'apps/web/scripts/serialize-dev-type-writes.mjs', 'apps/web/scripts/hidden-next-workers.mjs',
  'apps/web/scripts/atomic-development-assets.mjs', 'apps/web/lib/db/schema.pg.ts', 'apps/web/lib/db/migrate.ts',
  'apps/web/app/api/native/agent/route.ts', 'apps/web/lib/ai/runtime/answer-evidence-session.ts',
  'apps/web/lib/ai/runtime/answer-evidence-contract.ts', 'apps/web/lib/ai/loop-runtime-answer-guard.ts',
  'apps/web/lib/ai/native-pi-web-chat-tools.ts', 'apps/web/lib/ai/native-pi-user-config.ts',
  'apps/web/lib/ai/runtime/pi-tool-adapter.ts', 'apps/web/lib/ai/runtime/tool-executor.ts',
  'apps/web/lib/ai/platform-recall.ts', 'apps/web/lib/ai/loop-runtime-observation.ts',
  'apps/web/lib/db/agent-answer-audits.ts', 'apps/web/lib/db/owned-chat-messages.ts',
  'apps/web/lib/db/migrations/meta/_journal.json', 'apps/web/lib/db/migrations/0159_add_agent_answer_audits.sql',
  'packages/ai/src/agent/runtime/pi-harness-adapter.ts', 'packages/ai/src/agent/runtime/pi-model-config.ts',
  'pnpm-lock.yaml'];
const sourceSnapshot = Object.fromEntries(sourceFiles.map(file => [file, hash(fs.readFileSync(path.join(root, file)))]));
const workspaceProvenance = JSON.parse(fs.readFileSync(path.resolve(sourceWorkspaceArg), 'utf8'));
const workspaceSourceHashes = workspaceProvenance.sourceHashes;
const workspace = verifyEvalSourceWorkspace({ provenanceFile: path.resolve(sourceWorkspaceArg), expectedWorkspaceHash: workspaceProvenance.workspaceHash,
  sourceHashes: workspaceSourceHashes, formalRoot: root });
function verifyNativeWorkspaceSnapshot() {
  for (const [file, expected] of Object.entries(sourceSnapshot)) if (hash(fs.readFileSync(path.join(workspace.repositoryRoot, file))) !== expected) throw Error('Native supplemental workspace source drift');
}
verifyNativeWorkspaceSnapshot();
const sourceWorkspace = { ...workspace, sourceHashes: workspaceSourceHashes };
const workspaceProfileBase = path.join(workspace.repositoryRoot, '.runtime-eval', hash(output).slice(0, 24));
const manifestFile = path.join(output, 'manifest.json');
const write = (name: string, value: unknown) => fs.writeFileSync(path.join(output, name), JSON.stringify(value, null, 2) + '\n', 'utf8');
const inherited = new Set(Object.keys(process.env));
for (const file of [path.join(root, '.env'), path.join(web, '.env'), path.join(web, '.env.local')]) if (fs.existsSync(file)) for (const [key, value] of Object.entries(parse(fs.readFileSync(file)))) if (!inherited.has(key)) process.env[key] = value;
const packageFolder = path.dirname(originalRun), originalManifest = JSON.parse(fs.readFileSync(path.join(packageFolder, 'manifest.json'), 'utf8'));
const credentialOwner = arg('credential-owner') ?? originalManifest.ownerId;
if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(credentialOwner)) throw Error('Invalid configured credential owner');
// Same saved-provider priority as resolveNativePiUserConfig: enabled OpenAI,
// then enabled Anthropic. Synthetic owners have no provider settings; their
// isolated routes receive this locked RAM config through the environment.
const capturedProvider = await readSavedEvalProvider({ ownerId: credentialOwner, role: 'agent' });
const provider: any = { ...capturedProvider.config, baseUrl: normalizeEvalEndpoint(capturedProvider.config.baseUrl, capturedProvider.config.protocol) };
if (!provider.apiKey || !provider.baseUrl || !provider.model || !['anthropic-messages', 'openai-completions', 'openai-responses'].includes(provider.protocol)) throw Error('Configured real Pi provider unavailable');
const lockedConfig = { provider: 'pi', model: provider.model, protocol: provider.protocol, endpointHash: hash(provider.baseUrl),
  savedProvider: capturedProvider.snapshot,
  hasJevCredential: Boolean(process.env.TYPESAFE_API_KEY),
  jevFlags: Object.fromEntries(['BRAIN_JEV_ROUTING', 'BRAIN_JEV_MODE', 'BRAIN_JEV_TARGETED_RETRY'].map(key => [key, process.env[key] ?? null])) };
const lockedConfigHash = jsonHash(lockedConfig);
if (!process.argv.includes('--execute')) {
  if (fs.existsSync(output)) throw Error('Prepare a fresh supplementary output directory');
  fs.mkdirSync(output, { recursive: true });
  const oldRun = JSON.parse(fs.readFileSync(path.join(originalRun, 'run.json'), 'utf8'));
  const plan = { ...LOOP_CURRENT_COMPARISON_PROTOCOL, preparedAt: new Date().toISOString(), status: 'prepared_only',
    preparationProtocol: 'supplementary-native-http.v5', modelCalls: 0, productionWrites: 0, originalRun, sourceSnapshot, cases,
    sourceWorkspace: workspace, workspaceProfileBase,
    transportObservation: { mainProvider: 'The SDK retains the real locked base URL and vendor header decisions. An evaluation-only fetch loader redirects only its exact endpoint and formal SDK session marker to the transparent proxy, preserving body/headers/options. Nonmatching requests are outside main observations.',
      jev: 'Formal SSE routing metadata and usage only when emitted. Enforce gate may suppress reasoning metadata. External JEV network requests are not captured by the main-provider proxy; absent metadata never means zero JEV requests.' },
    lockedConfig, lockedConfigHash,
    original100: { runMetadataHash: hash(fs.readFileSync(path.join(originalRun, 'run.json'))),
      questionsHash: oldRun.questionsHash, corpusHash: oldRun.corpusHash, rubricHash: oldRun.rubricHash,
      denominator: 100, qa: 90, recordQa: 67, sourceQa: 23, workflows: 10,
      relation: 'Historical first-attempt reference. Reader/fixture/source fixes prevent strict matched causal attribution.',
      noOriginalGateEligibleCases: true, preserveFailures: true },
    independentScoring: { original100: 'Unchanged authored rubric; 90QA and 10workflows separate, provider and fixture errors stay in the 100 denominator.',
      supplementary: 'Protocol/fact coverage/unsupported extra claims/audit completeness separate. Independent evidence review required; no self-judge certification.',
      pairExclusions: ['Source/config/schema drift', 'Different initial native model prompt/tool schemas', 'Clock/lease/heartbeat state drift', 'Provider/runtime failure', 'Incomplete model-visible capture'] },
  };
  write('manifest.json', plan);
  for (const item of cases) for (const mode of LOOP_CURRENT_COMPARISON_PROTOCOL.arms) write(`${item.id}-${mode}.json`, { id: item.id, mode, status: 'not_run', modelCalls: 0 });
  await closeEvalProviderDatabase();
  console.log(JSON.stringify({ status: 'prepared_only', output, cases: cases.length, plannedModelSessions: 24, modelCalls: 0 }));
  process.exit(0);
}

const plan = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
if (plan.preparationProtocol !== 'supplementary-native-http.v5' || plan.status !== 'prepared_only' || JSON.stringify(plan.sourceSnapshot) !== JSON.stringify(sourceSnapshot) || JSON.stringify(plan.cases) !== JSON.stringify(cases)
  || plan.sourceWorkspace?.workspaceHash !== workspace.workspaceHash || plan.workspaceProfileBase !== workspaceProfileBase) throw Error('Supplementary source/plan/workspace drift or previously executed output; preserve first attempts');
assertExpectedEvalProvider(capturedProvider.snapshot, plan.lockedConfig?.savedProvider);
if (plan.lockedConfigHash !== lockedConfigHash || jsonHash(plan.lockedConfig) !== lockedConfigHash) throw Error('Prepared native configuration drift');
write('loaded-model-lock.json', { schemaVersion: 'native-supplement-config-lock.v1', ...lockedConfig, configHash: lockedConfigHash,
  credentialPolicy: 'Resolved once in host memory; credential values and auth headers are never persisted.' });
const adminUrl = parseLoopCurrentAdminUrl(process.env.ZHIYU_TEST_ADMIN_URL ?? process.env.POSTGRES_URL ?? process.env.DATABASE_URL ?? '');
const admin = postgres(adminUrl.toString(), { max: 1 });
const arms: any[] = [], outcomes: any[] = [];
let successful = false;

async function migrate(databaseUrl: string, mode: string) {
  parseLoopCurrentDatabaseUrl(databaseUrl);
  const log = fs.openSync(path.join(output, `migration-${mode}.log`), 'w');
  try { const child = spawn(process.execPath, ['--import', 'tsx', '--conditions=react-server', 'lib/db/migrate.ts'], {
    cwd: workspace.webDir, windowsHide: true, stdio: ['ignore', log, log], env: { ...process.env, NODE_ENV: 'test', ZHIYU_TEST_MODE: 'integration',
      POSTGRES_URL: databaseUrl, DATABASE_URL: databaseUrl, ZHIYU_TEST_DATABASE_URL: databaseUrl } });
    await new Promise((resolve, reject) => { child.once('error', () => reject(Error('Isolated migration process failed'))); child.once('exit', code => code === 0 ? resolve(undefined) : reject(Error('Isolated migration failed; inspect private log'))); });
  } finally { fs.closeSync(log); }
}
async function seedCase(client: any, item: any, at: string) {
  const ids = item.ids, scenario = item.scenario;
  await client.begin(async (sql: any) => {
    await sql`INSERT INTO "User"(id,email) VALUES (${ids.ownerId},${'comparison-owner@example.invalid'}),(${ids.foreignOwnerId},${'comparison-foreign@example.invalid'}) ON CONFLICT(id) DO NOTHING`;
    await sql`INSERT INTO "Chat"(id,"userId",title,"createdAt",visibility) VALUES (${ids.chatId},${ids.ownerId},${item.id},${at},'private')`;
    await sql`INSERT INTO "Message_v2"(id,"chatId",role,parts,attachments,"createdAt") VALUES (${ids.userMessageId},${ids.chatId},'user',${sql.json([{ type: 'text', text: item.question }])},'[]',${at})`;
    if (scenario === 'missing_loop') return;
    const owner = scenario === 'foreign_owner' ? ids.foreignOwnerId : ids.ownerId;
    await sql`INSERT INTO workshops(id,user_id,name,mission,status,created_at,updated_at) VALUES (${ids.workshopId},${owner},${item.id},${'Synthetic read-only observation fixture'},'active',${at},${at})`;
    await sql`INSERT INTO loops(id,user_id,workshop_id,name,goal,status,created_at,updated_at) VALUES (${ids.loopId},${owner},${ids.workshopId},${item.id},${'Observe only; do not execute'},${item.expected.loopStatus},${at},${at})`;
    if (scenario.includes('no_mapping') || scenario === 'foreign_owner') return;
    const runStatus = scenario === 'completed_run_active_mapping' ? 'completed' : 'running';
    await sql`INSERT INTO workshop_runs(id,workshop_id,status,started_at,created_at,updated_at) VALUES (${ids.runId},${ids.workshopId},${runStatus},${at},${at},${at})`;
    await sql`INSERT INTO loop_runs(id,loop_id,status,started_at,created_at,updated_at) VALUES (${ids.loopRunId},${ids.loopId},${runStatus},${at},${at},${at})`;
    await sql`INSERT INTO workshop_loop_executions(run_id,loop_run_id,loop_id,workshop_id,request_json,active,created_at) VALUES (${ids.runId},${ids.loopRunId},${ids.loopId},${ids.workshopId},'{}',true,${at})`;
    const heartbeat = new Date(Date.parse(at) + (scenario === 'stale_heartbeat' ? -600000 : 0)).toISOString();
    const until = new Date(Date.parse(at) + (scenario === 'expired_lease' ? -600000 : 3600000)).toISOString();
    await sql`INSERT INTO workshop_execution_leases(workshop_id,token,run_id,worker_id,phase,lease_until,heartbeat_at,updated_at) VALUES (${ids.workshopId},1,${scenario === 'lease_run_mismatch' ? ids.alternateRunId : ids.runId},${'synthetic-fixture-worker'},${scenario === 'needs_review_lease' ? 'needs_review' : 'running'},${until},${heartbeat},${at})`;
  });
  const snapshot = { question: item.question, ids, scenario, at,
    chat: await client`SELECT * FROM "Chat" WHERE id=${ids.chatId}`,
    inputMessage: await client`SELECT * FROM "Message_v2" WHERE id=${ids.userMessageId}`,
    loops: await client`SELECT * FROM loops WHERE id=${ids.loopId}`,
    runs: await client`SELECT * FROM workshop_runs WHERE id=${ids.runId}`,
    loopRuns: await client`SELECT * FROM loop_runs WHERE id=${ids.loopRunId}`,
    mapping: await client`SELECT * FROM workshop_loop_executions WHERE loop_id=${ids.loopId}`,
    leases: await client`SELECT * FROM workshop_execution_leases WHERE workshop_id=${ids.workshopId}` };
  return snapshot;
}
function checkSources() {
  for (const [file, expected] of Object.entries(sourceSnapshot)) if (hash(fs.readFileSync(path.join(root, file))) !== expected) throw Error('Supplementary code changed during evaluation');
  verifyEvalSourceWorkspace({ provenanceFile: workspace.provenanceFile, expectedWorkspaceHash: workspace.workspaceHash, sourceHashes: workspaceSourceHashes, formalRoot: root });
  verifyNativeWorkspaceSnapshot();
}
async function checkProvider() {
  const current = await readSavedEvalProvider({ ownerId: credentialOwner, role: 'agent' });
  assertExpectedEvalProvider(current.snapshot, capturedProvider.snapshot);
  if (configurationHash(current.config.apiKey) !== configurationHash(provider.apiKey)) throw Error('Effective provider credential changed');
}
async function preflightNativeHttp(arm: any) {
  // Unsupported provider returns before any SDK/model work. These POST checks
  // exercise the same-origin boundary that GET-only smoke cannot cover.
  const endpoint = `${arm.http.origin}/api/native/agent`, body = JSON.stringify({ prompt: 'Synthetic HTTP preflight only', provider: 'fixture-unsupported-provider' });
  const valid = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: arm.http.origin }, body, signal: AbortSignal.timeout(120000) });
  const foreign = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://cross-site.example.invalid' }, body, signal: AbortSignal.timeout(10000) });
  const noOrigin = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(10000) });
  const checks = [{ id: 'native_same_origin_invalid_provider_no_model', passed: valid.status === 400 },
    { id: 'native_cross_origin_rejected', passed: foreign.status === 403 }, { id: 'native_missing_origin_rejected', passed: noOrigin.status === 403 }];
  write(`http-preflight-${arm.mode}.json`, { mode: arm.mode, checks, actualModelSessions: 0, mainProviderRequests: arm.proxy.receipts.length });
  if (checks.some(check => !check.passed) || arm.proxy.receipts.length) throw Error('Formal native HTTP boundary preflight failed');
}
async function executeArm(arm: any, item: any, seedHash: string) {
  const filename = `${item.id}-${arm.mode}.json`, before = JSON.parse(fs.readFileSync(path.join(output, filename), 'utf8'));
  if (before.status !== 'not_run') throw Error('First supplementary attempt already exists');
  const request = { prompt: item.question, provider: 'pi', sessionId: `${item.id}-${arm.mode}`, chatId: item.ids.chatId,
    clientRequestId: `loop-current-${item.id}`, userMessageId: item.ids.userMessageId, assistantMessageId: item.ids.assistantMessageId,
    allowedTools: LOOP_CURRENT_COMPARISON_PROTOCOL.tools, loopIdForGuard: item.ids.loopId,
    modelConfig: { model: provider.model, thinkingLevel: 'disabled' }, permissionMode: 'default',
    skillsConfig: { enabled: false, userDirEnabled: false, appDirEnabled: false }, mcpConfig: { enabled: false, userDirEnabled: false, appDirEnabled: false } };
  const record: any = { id: item.id, mode: arm.mode, status: 'running', startedAt: new Date().toISOString(), request,
    initialSeedHash: seedHash, configHash: lockedConfigHash, sourceSnapshot, workspaceHash: workspace.workspaceHash, mainProviderRequests: 0,
    actualEntry: 'formal_native_http_route', origin: arm.http.origin, sourceModeEvidence: arm.mode === 'off' ? 'exact Pi no-phase request follows the saved native legacy guard branch' : 'formal reservation/session/gate plus runtime_loaded audit required' };
  write(filename, record); arm.proxy.beginCase(item.id);
  const timer = new AbortController(); const timeout = setTimeout(() => timer.abort(), LOOP_CURRENT_COMPARISON_PROTOCOL.budget.httpTimeoutMs);
  let streamText = '', response;
  try {
    checkSources(); await checkProvider(); response = await fetch(`${arm.http.origin}/api/native/agent`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: arm.http.origin }, body: JSON.stringify(request), signal: timer.signal });
    record.httpStatus = response.status; record.responseHeaders = { contentType: response.headers.get('content-type'), answerEvidenceProtocol: response.headers.get('x-answer-evidence-protocol') };
    if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) throw Error('Formal native request did not return SSE');
    const decoder = new TextDecoder();
    if (response.body) for await (const block of response.body) streamText += decoder.decode(block, { stream: true });
    streamText += decoder.decode(); record.status = 'returned';
  } catch { record.status = timer.signal.aborted ? 'timeout' : 'request_error'; record.error = 'Native HTTP request failed; raw credential-bearing exception messages are not persisted'; }
  finally { clearTimeout(timeout); arm.proxy.endCase(); }
  record.parsed = parseNativeSse(streamText);
  let safeStream = streamText;
  for (const secret of [provider.apiKey, provider.baseUrl, process.env.TYPESAFE_API_KEY].filter((value): value is string => Boolean(value))) safeStream = safeStream.replaceAll(secret, '[REDACTED]');
  fs.writeFileSync(path.join(output, `${item.id}-${arm.mode}-native-sse.txt`), safeStream, 'utf8');
  const turnId = record.parsed.events.find((event: any) => event.type === 'answer_evidence')?.answerEvidence?.turnId;
  if (turnId && /^[0-9a-f-]{36}$/i.test(turnId)) {
    try { const auditResponse = await fetch(`${arm.http.origin}/api/native/answer-audits/${turnId}`, { signal: AbortSignal.timeout(10000) }); record.auditHttpStatus = auditResponse.status; if (auditResponse.ok) record.audit = await auditResponse.json(); }
    catch { record.auditReadError = true; }
    record.privateAuditEvents = await arm.client`SELECT seq,event_key AS "eventKey",event_type AS "eventType",payload,runtime_hash AS "runtimeHash" FROM agent_answer_audits WHERE owner_id=${item.ids.ownerId} AND turn_id=${turnId} ORDER BY seq`;
  }
  record.providerObservations = arm.proxy.receipts.filter((receipt: any) => receipt.caseId === item.id);
  record.mainProviderRequests = record.providerObservations.length;
  record.deliveredAnswer = { text: record.parsed.deliveredText, sha256: record.parsed.deliveredTextHash, source: 'formal_native_sse_delivered_body' };
  const finalAudit = record.privateAuditEvents?.filter((event: any) => event.eventType === 'final_evidence').at(-1)?.payload;
  record.rawDraftObservation = finalAudit?.rawDraft
    ? { source: 'host_sealed_final_evidence', ...finalAudit.rawDraft }
    : { source: 'raw_provider_stream_artifacts', scope: 'Per-request provider text, not automatically a canonical final model answer.', metadataOnly: true };
  record.jevDecisionEvents = record.parsed.events.filter((event: any) => event.type === 'reasoning').flatMap((event: any) => {
    try { const value = JSON.parse(event.content); return ['jev_replaces_initial_recall_decision', 'jev_bounded_architecture_followup'].includes(value.stage) ? [value] : []; } catch { return []; }
  });
  record.jevNetworkRequestCount = 'not_transport_observed';
  record.jevDecisionVisibility = arm.mode === 'enforce_critical' ? 'may_be_suppressed_by_answer_gate' : 'formal_sse_when_emitted';
  record.protocol = inspectNativePairArm({ mode: arm.mode, parsed: record.parsed, audit: record.audit,
    privateAuditEvents: record.privateAuditEvents, request, fixtureExpected: item.expected,
    lockedProvider: { model: provider.model, protocol: provider.protocol }, providerObservations: record.providerObservations });
  record.finishedAt = new Date().toISOString();
  // Only response captures are scrubbed; actual request/response hashes retain original bytes.
  let serialized = JSON.stringify(record, null, 2) + '\n';
  for (const secret of [provider.apiKey, provider.baseUrl, process.env.TYPESAFE_API_KEY].filter((value): value is string => Boolean(value))) serialized = serialized.replaceAll(secret, '[REDACTED]');
  fs.writeFileSync(path.join(output, filename), serialized, 'utf8');
  return record;
}
try {
  if ((await admin`SELECT current_database() AS name`)[0]?.name !== 'postgres') throw Error('Administration database target mismatch');
  plan.status = 'running'; plan.executionStartedAt = new Date().toISOString(); write('manifest.json', plan);
  for (const [index, mode] of LOOP_CURRENT_COMPARISON_PROTOCOL.arms.entries()) {
    const name = `zhiyu_test_${randomUUID().replaceAll('-', '')}`;
    if (!/^zhiyu_test_[a-f0-9]{32}$/.test(name)) throw Error('Unsafe test DB identifier');
    const dbUrl = new URL(adminUrl); dbUrl.pathname = `/${name}`; dbUrl.search = ''; dbUrl.hash = '';
    parseLoopCurrentDatabaseUrl(dbUrl.toString(), name);
    const appHome = path.join(workspaceProfileBase, `home-${mode}`);
    if (fs.existsSync(appHome)) throw Error('Fresh synthetic workspace profile required');
    fs.mkdirSync(appHome, { recursive: true });
    fs.writeFileSync(path.join(appHome, '.synthetic-owner.json'), JSON.stringify({ output, workspaceHash: workspace.workspaceHash, ownerId: cases[0].ids.ownerId }), 'utf8');
    const arm: any = { mode, name, appHome, created: false }; arms.push(arm);
    await admin.unsafe(`CREATE DATABASE "${name}"`); arm.created = true;
    arm.client = postgres(dbUrl.toString(), { max: 2 });
    const actualDatabase = (await arm.client`SELECT current_database() AS name`)[0]?.name;
    if (actualDatabase !== name) throw Error('Fixture database target mismatch');
    await migrate(dbUrl.toString(), mode);
    await arm.client`INSERT INTO "User"(id,email) VALUES (${cases[0].ids.ownerId},${'comparison-owner@example.invalid'}),(${cases[0].ids.foreignOwnerId},${'comparison-foreign@example.invalid'}) ON CONFLICT(id) DO NOTHING`;
    arm.proxy = await startLoopCurrentProviderProxy({ upstreamBaseUrl: provider.baseUrl, outputDir: path.join(output, `provider-${mode}`), arm: mode, model: provider.model, protocol: provider.protocol, secrets: [provider.apiKey] });
    arm.http = await startLoopCurrentHttp({ databaseUrl: dbUrl.toString(), ownerId: cases[0].ids.ownerId, appHome, mode,
      provider, observerProxyBaseUrl: arm.proxy.baseUrl, reviewBuild: String(94 + index), sourceWorkspace,
      jevEnvironment: Object.fromEntries(['BRAIN_JEV_ROUTING', 'BRAIN_JEV_MODE', 'BRAIN_JEV_TARGETED_RETRY', 'TYPESAFE_API_KEY'].map(key => [key, process.env[key] ?? ''])) });
    const identity = await fetch(`${arm.http.origin}/api/identity`, { signal: AbortSignal.timeout(120000) });
    if (!identity.ok || (await identity.json()).actorId !== cases[0].ids.ownerId) throw Error('Isolated HTTP owner did not match');
    await preflightNativeHttp(arm);
    write(`isolation-${mode}.json`, { schemaVersion: 'native-loop-comparison-isolation.v1', mode, database: name,
      ownerId: cases[0].ids.ownerId, realProviderEndpointHash: arm.proxy.endpointHash, resolvedProxyUrl: arm.proxy.resolvedProxyUrl,
      sourceSnapshot, sourceWorkspace: workspace, configHash: lockedConfigHash, productionWrites: false, profile: appHome,
      actualDatabase, schedulerEnabled: false, startupListenersEnabled: false });
  }
  for (const item of cases) {
    checkSources(); await checkProvider(); const at = new Date().toISOString();
    const snapshots = await Promise.all(arms.map(arm => seedCase(arm.client, item, at)));
    if (jsonHash(snapshots[0]) !== jsonHash(snapshots[1])) throw Error('Matched pair initial seed differs');
    write(`${item.id}-initial-state.json`, { snapshots, initialSeedHash: jsonHash(snapshots[0]) });
    const records = await Promise.all(arms.map(arm => executeArm(arm, item, jsonHash(snapshots[0]))));
    const firstProvider = records.map(record => record.providerObservations.find((receipt: any) => receipt.observedToolNames.length));
    const promptMatch = firstProvider.every(Boolean) && firstProvider[0].modelVisibleContextHash === firstProvider[1].modelVisibleContextHash;
    const toolMatch = firstProvider.every(Boolean) && firstProvider[0].modelVisibleToolSchemaHash === firstProvider[1].modelVisibleToolSchemaHash;
    const budgetMatch = firstProvider.every(Boolean) && jsonHash(firstProvider[0].observedBudget) === jsonHash(firstProvider[1].observedBudget);
    const modelProtocolMatch = firstProvider.every((receipt: any) => receipt && receipt.observedModel === provider.model && receipt.observedProtocol === provider.protocol);
    const stateMatch = records.every(record => record.protocol.temporalStateMatches === true);
    outcomes.push({ id: item.id, initialSeedMatched: true, initialProviderPromptMatched: promptMatch,
      actualToolSchemaMatched: toolMatch, providerBudgetMatched: budgetMatch, actualModelProtocolMatched: modelProtocolMatch, temporalStateMatch: stateMatch,
      status: promptMatch && toolMatch && budgetMatch && modelProtocolMatch && stateMatch && records.every(record => record.protocol.protocolValid && record.protocol.executionOutcome === 'completed') ? 'ready_for_independent_semantic_review' : 'inconclusive',
      semanticJudgment: 'not_run', modelCorrectnessCertified: false });
    write('pair-protocol-results.json', { schemaVersion: 'native-loop-matched-pair-protocol.v1', outcomes });
    console.log(JSON.stringify({ id: item.id, status: outcomes.at(-1).status, rawAttemptsRetained: 2 }));
  }
  successful = true;
} finally {
  const cleanup = [];
  for (const arm of arms.reverse()) {
    const errors = [];
    try { if (arm.http) await arm.http.stop(); } catch { errors.push('http_stop_failed'); }
    try { if (arm.proxy) await arm.proxy.stop(); } catch { errors.push('provider_proxy_stop_failed'); }
    try { if (arm.client) await arm.client.end(); } catch { errors.push('fixture_connection_close_failed'); }
    if (arm.created) try { await admin`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=${arm.name} AND pid<>pg_backend_pid()`; await admin.unsafe(`DROP DATABASE "${arm.name}"`); } catch { errors.push('test_database_drop_failed'); }
    const remaining = await admin`SELECT datname FROM pg_database WHERE datname=${arm.name}`;
    try { const marker = JSON.parse(fs.readFileSync(path.join(arm.appHome, '.synthetic-owner.json'), 'utf8'));
      if (path.relative(workspaceProfileBase, arm.appHome) !== `home-${arm.mode}` || marker.output !== output
        || marker.workspaceHash !== workspace.workspaceHash || marker.ownerId !== cases[0].ids.ownerId) throw Error();
      fs.rmSync(arm.appHome, { recursive: true }); } catch { errors.push('synthetic_profile_cleanup_failed'); }
    cleanup.push({ mode: arm.mode, status: !errors.length && !remaining.length ? 'completed' : 'failed', databaseAbsent: !remaining.length, profileAbsent: !fs.existsSync(arm.appHome), receiptsPreserved: true, errors });
  }
  await admin.end();
  await closeEvalProviderDatabase();
  write('cleanup.json', { schemaVersion: 'native-loop-comparison-cleanup.v1', arms: cleanup });
  plan.status = successful ? 'captured_pending_independent_semantic_review' : 'execution_failed'; plan.finishedAt = new Date().toISOString();
  plan.cleanupComplete = cleanup.every(arm => arm.status === 'completed'); write('manifest.json', plan);
}
console.log(JSON.stringify({ output, status: plan.status, pairs: outcomes.length, modelCorrectnessCertified: false }));
