import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import postgres from 'postgres';
import { parse } from 'dotenv';
import { prepareWorkflow, verifyStoredWorkflow } from './lib/platform-eval-v2-workflows.mjs';

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(web, '../..');
const allowedRoot = resolve(root, '.runtime/checks/platform-evidence-i1');
const outputRoot = resolve(process.argv[2] ?? resolve(allowedRoot, `workflow-facts-${new Date().toISOString().replaceAll(':', '-')}`));
assert.ok(outputRoot.startsWith(allowedRoot + sep), 'Contract outputs must stay in the named checks directory');
assert.ok(!existsSync(outputRoot), 'Do not overwrite a prior check or original evaluation');
await mkdir(outputRoot, { recursive: true });
const summaries = [];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function save(file, value) { await writeFile(file, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' }); }

async function isolatedFixtureConnection(fixtureFolder) {
  const isolation = JSON.parse(await readFile(resolve(fixtureFolder, 'isolation.json'), 'utf8'));
  const metadata = JSON.parse(await readFile(resolve(fixtureFolder, 'fixture-metadata.json'), 'utf8'));
  assert.match(isolation.database, /^zhiyu_test_[a-f0-9]{32}$/);
  assert.equal(isolation.productionWrites, false);
  assert.equal(metadata.ownerId, isolation.ownerId);
  const env = {};
  for (const file of [resolve(root, '.env'), resolve(web, '.env')]) if (existsSync(file)) Object.assign(env, parse(await readFile(file)));
  Object.assign(env, process.env);
  const url = new URL(env.ZHIYU_TEST_ADMIN_URL || env.POSTGRES_URL || env.DATABASE_URL);
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  assert.ok(!url.search && !url.hash);
  url.pathname = `/${isolation.database}`;
  const client = postgres(url.toString(), { max: 1, onnotice: () => {} });
  try { assert.equal((await client`SELECT current_database() AS database`)[0].database, isolation.database); }
  catch (error) { await client.end(); throw error; }
  return { client, isolation, metadata, connectionUrl: url.toString() };
}

async function pauseProbeSnapshot(connection) {
  const { client, isolation, metadata } = connection;
  assert.equal((await client`SELECT current_database() AS database`)[0].database, isolation.database);
  return {
    database: isolation.database,
    clock: (await client`SELECT observed_at FROM public.workflow_fixture_clock WHERE id=1`)[0].observed_at.toISOString(),
    loop: await client`SELECT * FROM loops WHERE id=${metadata.loopId} AND user_id=${isolation.ownerId}`,
    state: await client`SELECT * FROM loop_states WHERE loop_id=${metadata.loopId}`,
    runs: await client`SELECT * FROM loop_runs WHERE loop_id=${metadata.loopId} ORDER BY id`,
    workRuns: await client`SELECT * FROM workshop_runs WHERE workshop_id=${metadata.workshopId} ORDER BY id`,
    executions: await client`SELECT * FROM workshop_loop_executions WHERE loop_id=${metadata.loopId} ORDER BY run_id`,
    events: await client`SELECT * FROM workshop_events WHERE workshop_id=${metadata.workshopId} ORDER BY id`,
    artifactHash: hash(await readFile(resolve(outputRoot, connection.checkName, 'fixtures/REAL-100/previous-artifact.txt'))),
  };
}

async function acceptFixtureSlot(connection) {
  const { client, isolation, metadata } = connection;
  assert.equal((await client`SELECT current_database() AS database`)[0].database, isolation.database);
  await client`UPDATE public.workflow_fixture_clock SET observed_at=${metadata.futureSlot}::timestamptz WHERE id=1`;
  const child = spawn(process.execPath, ['--import', './tests/integration/deny-external-transports.mjs', '--import', 'tsx', '--conditions=react-server',
    'tests/integration/loop-schedule-worker.mjs', JSON.stringify({ userId: isolation.ownerId, workId: metadata.workshopId, loopId: metadata.loopId, scheduledAt: metadata.futureSlot, mode: 'dry_run' })], {
    cwd: web, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'test', ZHIYU_TEST_MODE: 'integration', ZHIYU_TEST_DATABASE_URL: connection.connectionUrl,
      POSTGRES_URL: connection.connectionUrl, DATABASE_URL: connection.connectionUrl, ENABLE_LOCAL_SCHEDULER: 'false', ENABLE_STARTUP_LISTENERS: 'false', TAURI_MODE: 'false', IS_TAURI: 'false' },
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
  const exitCode = await new Promise((resolveExit, reject) => { child.once('error', reject); child.once('exit', resolveExit); });
  await save(resolve(outputRoot, connection.checkName, 'prior-formal-admission.json'), { exitCode, stdout, stderr, modelInvoked: false });
  assert.equal(exitCode, 0, stderr);
  const receipt = JSON.parse(stdout.split('\n').findLast(line => line.startsWith('{"state"')));
  assert.equal(receipt.state, 'accepted'); assert.equal(receipt.replayed, false);
  return receipt;
}

async function runCheck(name, id, withProbe = false, deniedProbe = null) {
  const runFolder = resolve(outputRoot, name), fixtureFolder = resolve(runFolder, 'fixtures', id);
  const startedAt = new Date().toISOString();
  const workflow = await prepareWorkflow({ id, outputDir: fixtureFolder });
  let cleanup, connection, guardEvidence;
  try {
    assert.equal(workflow.status, 'ready', workflow.reason);
    const facts = JSON.parse(workflow.promptContext), before = JSON.parse(await readFile(resolve(fixtureFolder, 'before.json'), 'utf8'));
    let sequence = 0;
    const execute = async (name, params = {}) => {
      const tool = workflow.tools.find(tool => tool.name === name); assert.ok(tool, `Missing actual fixture tool ${name}`);
      const result = await tool.execute(`contract-${++sequence}`, params);
      return JSON.parse(result.content.filter(block => block.type === 'text').map(block => block.text).join('\n'));
    };
    if (id === 'REAL-085') {
      assert.equal(before.run.status, 'needs_review'); assert.equal(before.lease.phase, 'needs_review'); assert.equal(before.outbox.status, 'unknown');
      assert.ok(Date.parse(before.lease.lease_until) <= Date.parse(before.setupCancellation.observedAt));
      assert.equal(before.setupCancellation.formalService, 'cancelWorkRun'); assert.equal(before.setupCancellation.result.changed, true);
      const review = await execute('readRunReview'); assert.equal(review.run.reviewable, true); assert.equal(review.run.status, 'needs_review'); assert.equal(review.outbox.status, 'unknown');
      const provider = await execute('readSandboxSendReceipt'); assert.equal(provider.status, 'sent'); assert.equal(provider.sendCount, 1);
      const resolution = await execute('resolveWorkOutbox', { commandId: `contract-resolution:${randomUUID()}`, decision: 'sent', evidence: 'The isolated provider receipt confirms exactly one prior delivery; this action reconciles it without sending.', expectedContentHash: review.outbox.contentHash });
      assert.equal(resolution.status, 'sent');
    } else {
      connection = await isolatedFixtureConnection(fixtureFolder); connection.checkName = name;
      const initial = await pauseProbeSnapshot(connection);
      if (deniedProbe === 'active') {
        await assert.rejects(execute('observeNextScheduleAdmission'), /paused_probe_denied: paused_loop_required/);
        const afterDenied = await pauseProbeSnapshot(connection);
        assert.deepEqual(afterDenied, initial);
        guardEvidence = { condition: 'active_loop', unchanged: true, before: initial, after: afterDenied };
      }
      if (deniedProbe === 'old_slot') {
        const receipt = await acceptFixtureSlot(connection);
        assert.equal((await connection.client`SELECT current_database() AS database`)[0].database, connection.isolation.database);
        await connection.client`UPDATE public.workflow_fixture_clock SET observed_at=${before.clockInitial.observed_at}::timestamptz WHERE id=1`;
        guardEvidence = { condition: 'previously_accepted_slot', priorFormalReceipt: receipt };
      }
      const beforePause = await pauseProbeSnapshot(connection);
      const pause = await execute('pauseLoop', { loopId: facts.loopId, commandId: `contract-pause:${randomUUID()}`, reason: 'Isolated source and admission contract check' });
      assert.equal(Object.hasOwn(pause, 'nextScheduledRunAt'), false);
      assert.equal(pause.receiptSemantics.scheduleUpdate.status, 'not_recomputed');
      assert.equal(pause.receiptSemantics.futureAdmissionObservation, 'not_observed_by_this_command');
      assert.equal(pause.receiptSemantics.inFlightCancellation, 'not_requested_by_this_command');
      const refreshed = await execute('refreshLoopAndHistory');
      assert.equal(refreshed.observationCoverage.futureAdmission, 'not_observed');
      const afterPause = await pauseProbeSnapshot(connection);
      assert.deepEqual(afterPause.state, beforePause.state);
      assert.deepEqual(afterPause.runs, beforePause.runs);
      assert.equal(afterPause.artifactHash, initial.artifactHash);
      if (deniedProbe === 'old_slot') {
        await assert.rejects(execute('observeNextScheduleAdmission'), /paused_probe_denied: fresh_unaccepted_slot_required/);
        const afterDenied = await pauseProbeSnapshot(connection);
        assert.deepEqual(afterDenied, afterPause);
        guardEvidence = { ...guardEvidence, unchanged: true, before: afterPause, after: afterDenied };
      }
      if (guardEvidence) await save(resolve(runFolder, 'probe-guard-evidence.json'), guardEvidence);
      if (withProbe) { const probe = await execute('observeNextScheduleAdmission'); assert.equal(probe.receipt.state, 'paused'); }
      await connection.client.end(); connection = null;
    }
    const producer = await workflow.verify({ answer: '' });
    const after = JSON.parse(await readFile(resolve(fixtureFolder, 'after.json'), 'utf8'));
    const calls = JSON.parse(await readFile(resolve(fixtureFolder, 'calls.json'), 'utf8'));
    cleanup = await workflow.cleanup(); assert.equal(cleanup.status, 'completed'); assert.equal(cleanup.databaseDropped, true);
    const record = { id, status: 'scripted_contract_check', startedAt, finishedAt: new Date().toISOString(), metadata: { engine: 'scripted_contract_check', modelInvoked: false }, workflow: { ...producer, cleanup } };
    await save(resolve(runFolder, `${id}.contract.json`), record);
    const independent = await verifyStoredWorkflow({ record, runFolder });
    await save(resolve(runFolder, 'independent-contract-verification.json'), independent);
    assert.equal(independent.status, 'fixture_error', 'A no-model driver must never be accepted as a model result');
    assert.deepEqual(independent.errors, ['Scripted contract checks cannot count as model workflow results', ...calls.map(call => `Fixture call has no matching actual model event: ${call.toolName}:${call.toolCallId}`)]);
    assert.equal(independent.requiresAnswerJudgment, true);
    const expectedState1 = id === 'REAL-085' || withProbe;
    assert.equal(producer.assertions.find(check => check.id === 'state.0').passed, true);
    assert.equal(independent.serviceChecks.find(check => check.id === 'state.0').passed, true);
    assert.equal(producer.assertions.find(check => check.id === 'state.1').passed, expectedState1);
    assert.equal(independent.serviceChecks.find(check => check.id === 'state.1').passed, expectedState1);
    if (id === 'REAL-085') {
      assert.equal(calls.filter(call => ['cancelWorkRun', 'resolveWorkRun'].includes(call.toolName)).length, 0);
      assert.equal(independent.serviceChecks[0].detail.setupCancellationVerified, true);
      assert.ok(producer.receipts.some(receipt => receipt.path === 'setup-cancellation.json'));
    } else {
      const producerDetail = producer.assertions.find(check => check.id === 'state.1').detail;
      const independentDetail = independent.serviceChecks.find(check => check.id === 'state.1').detail;
      assert.equal(producerDetail.clockAdvanceVerified, withProbe); assert.equal(independentDetail.clockAdvanceVerified, withProbe);
      assert.equal(producerDetail.probeCallObserved, withProbe || Boolean(deniedProbe)); assert.equal(independentDetail.probeCallObserved, withProbe || Boolean(deniedProbe));
      if (!withProbe) {
        assert.equal(after.scheduler.length, 0); assert.equal(after.clock.observed_at, before.clockInitial.observed_at);
        const expectedCoverage = deniedProbe ? 'probe_observed_without_verified_fresh_slot_admission' : 'no_probe_observed';
        assert.equal(producerDetail.coverage, expectedCoverage); assert.equal(independentDetail.coverage, expectedCoverage);
      } else assert.equal(independent.serviceChecks.find(check => check.id === 'state.2').passed, true);
    }
    summaries.push({ name, id, passed: true, modelInvoked: false, modelScore: null, actualServiceCalls: true,
      modelResultRejected: true, actualModelToolCallCount: 0, scriptedToolCallCount: calls.length, state0: true, state1: expectedState1,
      coverage: id === 'REAL-100' ? independent.serviceChecks.find(check => check.id === 'state.1').detail.coverage : 'formal_setup_cancel_then_reconcile_one_prior_send',
      cleanup: cleanup.status, databaseDropped: cleanup.databaseDropped, probeGuardUnchanged: guardEvidence?.unchanged ?? null });
  } catch (error) {
    summaries.push({ name, id, passed: false, modelInvoked: false, error: error.message });
  } finally {
    if (connection) { try { await connection.client.end(); } catch (error) { summaries.at(-1).fixtureConnectionCloseError = error.message; } }
    if (!cleanup) { try { cleanup = await workflow.cleanup(); } catch (error) { summaries.at(-1).cleanupError = error.message; } }
  }
}
await runCheck('cancelled-085', 'REAL-085');
await runCheck('paused-100-without-probe', 'REAL-100');
await runCheck('paused-100-with-probe', 'REAL-100', true);
await runCheck('active-100-probe-denied', 'REAL-100', false, 'active');
await runCheck('old-slot-100-probe-denied', 'REAL-100', false, 'old_slot');
const report = { at: new Date().toISOString(), track: 'no-model-isolated-contracts', paidModelCalls: 0, productionBusinessActions: 0,
  sourceHashes: Object.fromEntries(await Promise.all(['scripts/check-platform-eval-v2-workflow-facts.mjs', 'scripts/lib/platform-eval-v2-workflows.mjs', 'scripts/lib/platform-eval-v2-workflow-worker.mts', 'scripts/lib/platform-eval-v2-http-server.mjs',
    'lib/work-runtime/commands.ts', 'lib/work-runtime/loop-update-receipt.ts'].map(async file => [file, hash(await readFile(resolve(web, file)))]))),
  checks: summaries, passed: summaries.filter(check => check.passed).length, failed: summaries.filter(check => !check.passed).length };
await save(resolve(outputRoot, 'report.json'), report);
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.failed ? 1 : 0;
