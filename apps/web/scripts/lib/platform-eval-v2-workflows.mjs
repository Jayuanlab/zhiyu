import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Type } from '@earendil-works/pi-ai';

const web = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const worker = resolve(web, 'scripts/lib/platform-eval-v2-workflow-worker.mts');
const prefix = 'PLATFORM_WORKFLOW:';

/** Each model tool is an RPC to a separate process with its own isolated DB.
 * The parent process's cached production DB, credentials and tools are unused.
 * Verification observes model tool calls; it never performs the requested action.
 */
export async function prepareWorkflow({ id, outputDir }) {
  if (!/^REAL-(014|026|044|048|064|071|085|089|094|100)$/.test(id)) throw Error(`Unsupported workflow ${id}`);
  const directory = resolve(outputDir);
  await mkdir(directory, { recursive: true });
  const child = spawn(process.execPath, ['--conditions=react-server', '--import', 'tsx', worker, id, directory], {
    cwd: web, env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  let sequence = 0, buffer = '', diagnostic = '', closed = false;
  const pending = new Map();
  let readyResolve, readyReject;
  const ready = new Promise((resolveReady, rejectReady) => { readyResolve = resolveReady; readyReject = rejectReady; });
  const readyTimeout = setTimeout(() => readyReject(Error('Workflow fixture initialization timed out')), 180_000);
  child.stderr.on('data', data => { diagnostic = (diagnostic + data.toString()).slice(-12000); });
  child.stdout.on('data', data => {
    buffer += data.toString();
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!line.startsWith(prefix)) { diagnostic = (diagnostic + line + '\n').slice(-12000); continue; }
      let response; try { response = JSON.parse(line.slice(prefix.length)); } catch { continue; }
      if (response.kind === 'ready') { clearTimeout(readyTimeout); readyResolve(response.result); continue; }
      const request = pending.get(response.requestId);
      if (request) { pending.delete(response.requestId); clearTimeout(request.timer); response.ok ? request.resolve(response.result) : request.reject(Error(response.error)); }
    }
  });
  child.on('error', error => { clearTimeout(readyTimeout); readyReject(error); });
  child.on('exit', code => {
    closed = true; clearTimeout(readyTimeout);
    const error = Error(`Workflow worker exited (${code}); ${diagnostic.slice(-1000)}`);
    readyReject(error);
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear();
  });
  function rpc(method, params = {}) {
    if (closed) return Promise.reject(Error('Workflow worker is closed'));
    const requestId = ++sequence;
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => { pending.delete(requestId); rejectRequest(Error(`Workflow ${method} timed out`)); }, 60_000);
      pending.set(requestId, { resolve: resolveRequest, reject: rejectRequest, timer });
      child.stdin.write(JSON.stringify({ requestId, method, params }) + '\n');
    });
  }
  let initial;
  try { initial = await ready; }
  catch (error) {
    child.stdin.end();
    const failure = { id, status: 'fixture_error', reason: error.message, workflowExecutionPassed: false };
    await writeFile(resolve(directory, 'fixture-error.json'), JSON.stringify(failure, null, 2), 'utf8');
    return { ...failure, adapterId: 'platform-eval-v2-isolated-services.v1', promptContext: '', tools: [], verify: async () => failure, cleanup: async () => ({ status: 'failed', databaseCleanupUnverified: true }) };
  }
  const tools = (initial.tools ?? []).map(description => ({ ...description, label: description.name,
    parameters: Type.Unsafe(description.parameters), replay: 'never', executionMode: 'sequential',
    execute: async (toolCallId, params, signal) => {
      signal?.throwIfAborted();
      const result = await rpc('execute', { toolName: description.name, toolCallId, params });
      signal?.throwIfAborted();
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: { isolatedWorkflow: id, toolCallId } };
    },
  }));
  return { ...initial, adapterId: 'platform-eval-v2-isolated-services.v1', tools,
    verify: async ({ answer = '' } = {}) => rpc('verify', { answer }),
    cleanup: async () => {
      if (closed) return { status: 'worker_already_closed', databaseCleanupUnverified: true };
      const result = await rpc('cleanup'); child.stdin.end();
      await writeFile(resolve(directory, 'worker-diagnostics.log'), diagnostic, 'utf8');
      return result;
    },
  };
}

/** Recheck saved physical receipts after cleanup, without trusting a worker's
 * assertions or success flags. Model answers still require the v2 answer judge.
 */
export async function verifyStoredWorkflow({ record, runFolder }) {
  const adapterId = 'platform-eval-v2-isolated-services.v1';
  const errors = [], checks = [], diagnostics = {};
  const id = record.id;
  const directory = resolve(runFolder, 'fixtures', id);
  const fixtureFailure = record.status === 'fixture_error' || record.workflow?.status === 'fixture_error' && !record.workflow?.receipts;
  if (fixtureFailure) return { adapterId, status: 'fixture_error', checks, errors: [record.error ?? record.workflow?.reason ?? 'Fixture unavailable'], requiresAnswerJudgment: true };
  if (record.workflow?.adapterId !== adapterId) errors.push('Unknown workflow adapter');
  if (record.metadata?.engine !== 'pi') errors.push('Scripted contract checks cannot count as model workflow results');
  const receipts = record.workflow?.receipts;
  const expectedFiles = ['before.json', 'after.json', 'calls.json', 'evidence.json', 'isolation.json', 'fixture-metadata.json',
    ...(id === 'REAL-085' && Array.isArray(receipts) && receipts.some(item => item.path === 'setup-cancellation.json') ? ['setup-cancellation.json'] : []),
    ...(id==='REAL-071' && Array.isArray(receipts) && receipts.some(item=>item.path==='http-source-workspace.json')?['http-source-workspace.json']:[])];
  if (!Array.isArray(receipts)) return { adapterId, status: 'fixture_error', checks, errors: ['Physical receipt manifest missing'], requiresAnswerJudgment: true };
  const stored = {};
  try {
    for (const filename of expectedFiles) {
      const receipt = receipts.find(item => item.path === filename);
      if (!receipt || !/^[a-f0-9]{64}$/.test(receipt.sha256 ?? '')) throw Error(`Missing hashed receipt ${filename}`);
      const absolute = resolve(directory, filename);
      if (!absolute.startsWith(directory + sep)) throw Error('Receipt path escapes fixture');
      const bytes = await readFile(absolute);
      if (createHash('sha256').update(bytes).digest('hex') !== receipt.sha256) throw Error(`Receipt hash mismatch ${filename}`);
      stored[filename] = JSON.parse(bytes.toString('utf8'));
    }
  } catch (error) { return { adapterId, status: 'fixture_error', checks, errors: [...errors, error.message], receipts, requiresAnswerJudgment: true }; }
  const before = stored['before.json'], after = stored['after.json'], calls = stored['calls.json'], metadata = stored['fixture-metadata.json'], isolation = stored['isolation.json'];
  if (id === 'REAL-085' && metadata.fixtureContractVersion === 'platform-eval-v2-workflow.v2' && !stored['setup-cancellation.json']) errors.push('Missing hashed setup cancellation receipt');
  const owner = isolation.ownerId;
  if (isolation.id !== id || metadata.id !== id || !/^zhiyu_test_[a-f0-9]{32}$/.test(isolation.database ?? '') || isolation.productionWrites !== false || metadata.ownerId !== owner) errors.push('Invalid isolated fixture ownership or target');
  if (!Array.isArray(calls) || !calls.length) errors.push('No actual model tool calls in fixture');
  const modelCalls = record.toolCalls ?? record.events?.filter(event => event.type === 'tool_use') ?? [];
  for (const call of calls) {
    if (!modelCalls.some(event => (event.id ?? event.toolCallId ?? event.toolUseId) === call.toolCallId && (event.name ?? event.toolName) === call.toolName)) errors.push(`Fixture call has no matching actual model event: ${call.toolName}:${call.toolCallId}`);
  }
  const observed = name => calls.filter(call => call.toolName === name);
  const check = (key, type, passed, detail = {}) => checks.push({ id: key, type, passed: Boolean(passed), detail });
  const equal = (left, right) => {
    if (left === right) return true;
    if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
    const keys = Object.keys(left); return keys.length === Object.keys(right).length && keys.every(key => equal(left[key], right[key]));
  };
  if (id === 'REAL-014') {
    check('state.0', 'database_snapshot', before.status === 'dismissed' && after.item.status === 'pending' && after.item.metadata.resolution === null && equal(before.metadata.resolution, after.item.metadata.previousResolution) && after.item.metadata.restoredFromDecisionEventId === metadata.eventId);
    check('state.1', 'event_log', observed('restoreReviewAssistantDecision').filter(c => c.ok).length >= 2 && after.events.filter(e => e.type === 'review_assistant_decision_restored' && e.metadata.itemId === metadata.itemId && e.metadata.decisionEventId === metadata.eventId).length === 1);
  } else if (id === 'REAL-026') {
    const denied = call => call.ok === false && /denied|revoked|forbidden|not.authori[sz]ed|not.registered/i.test(call.error ?? '')
      || call.result?.status === 'rejected' && /denied|revoked|forbidden|tool_not_registered|not_authori[sz]ed/i.test(call.result?.code ?? '');
    check('state.0', 'tool_receipt', observed('Read').some(denied) && observed('attemptWrite').some(denied));
    check('state.1', 'file_snapshot', before.hash === after.hash && before.content === after.content);
  } else if (id === 'REAL-044') {
    check('state.0', 'database_snapshot', after.task.status === 'dismissed' && after.task.user_id === owner && equal(before.task.sourceEventIds, after.task.source_event_ids) && after.task.source_event_ids.includes(metadata.eventId) && observed('updateInteractionTaskStatus').some(c => c.ok));
    check('state.1', 'content_hash', before.raw.content === after.raw.content && before.raw.id === after.raw.id && before.raw.user_id === after.raw.user_id);
  } else if (id === 'REAL-048') {
    const reads = after.reads.filter(c => c.ok && c.result.status === 'read');
    check('state.0', 'evidence_links', before.length === 2 && before[0].subject === before[1].subject && before[0].content !== before[1].content && before[0].updatedAt === before[1].updatedAt && before.every(row => reads.some(c => {
      if (c.params.source !== 'interactionEvents' || !row.evidenceRefs.includes(`interactionEvents:${c.params.id}`)) return false;
      try { return JSON.parse(c.result.content).fields.content === row.content; } catch { return false; }
    })), { additionalBrainContextMembershipNotRequired: true, semanticConflictDisclosureRequiresAnswerJudgment: true });
  } else if (id === 'REAL-064') {
    const pack = after.packs.at(-1), [valid, expired, superseded, deleted, foreign] = before;
    check('state.0', 'context_log', pack && after.logs.some(log => log.id === pack.contextLogId && log.user_id === owner) && pack.items.some(item => item.id === valid.id) && [expired, superseded, deleted, foreign].every(row => !pack.items.some(item => item.id === row.id)) && pack.denied.some(row => row.id === expired.id && row.reason === 'expired') && pack.omitted.some(row => row.id === superseded.id) && pack.omitted.some(row => row.id === deleted.id) && after.foreignDenial.reason === 'wrong_user');
  } else if (id === 'REAL-071') {
    if (metadata.httpSourceWorkspaceHash && (!stored['http-source-workspace.json'] || stored['http-source-workspace.json'].workspaceHash!==metadata.httpSourceWorkspaceHash
      || stored['http-source-workspace.json'].generationScope?.originalDWorkspaceUsed!==false
      || !/^C:[\\/]/iu.test(stored['http-source-workspace.json'].generationScope?.webDir??'')
      || stored['http-source-workspace.json'].databaseIdentity?.expected!==isolation.database
      || stored['http-source-workspace.json'].databaseIdentity?.actual!==isolation.database)) errors.push('Pinned isolated C HTTP source workspace receipt mismatch');
    const posts = after.apiReceipts.filter(receipt => receipt.method === 'POST'), gets = after.apiReceipts.filter(receipt => receipt.method === 'GET');
    const expectedTransport = metadata.apiTransport === 'isolated_loopback_HTTP_to_Next_server' ? metadata.apiTransport : 'in_process_NextRequest_to_formal_route';
    check('state.0', 'api_receipt', posts.length >= 2 && gets.length > 0 && after.apiReceipts.every(receipt => receipt.status === 200 && receipt.actorId === owner && receipt.handler === 'app/api/workshops/[id]/workspace/route.ts' && receipt.transport === expectedTransport && receipt.body.workspace.userId === owner && receipt.body.workspace.workshopId === metadata.workshopId) && posts.every(receipt => receipt.body.workspace.status === 'ready') && gets.at(-1)?.body.workspace.status === 'ready');
    check('state.1', 'event_log', posts.length >= 2 && after.events.filter(event => event.type === 'workspace_prepared').length === 1 && after.events.filter(event => event.type === 'workspace_preparation_requested').length === 1);
    const legacyArtifactPath = `sessions/loops/${metadata.legacyLoopId}/${metadata.historyRunId}/old-artifact.txt`;
    check('state.2', 'filesystem_snapshot', gets.length > 0 && gets.every(receipt => equal(receipt.filesystemBefore, receipt.filesystemAfter) && receipt.eventsBefore === receipt.eventsAfter) && before.historyHash === after.historyHash
      && before.filesystem.some(entry => entry.path === legacyArtifactPath && entry.hash === before.historyHash) && after.filesystem.some(entry => entry.path === legacyArtifactPath && entry.hash === after.historyHash));
  } else if (id === 'REAL-085') {
    const firstRead = observed('readRunReview').find(call => call.ok)?.result?.run;
    const initializedAsCancelled = before.run.status === 'needs_review' && before.lease.phase === 'needs_review'
      && before.lease.effect_started === true && Date.parse(before.lease.lease_until) <= Date.parse(before.setupCancellation?.observedAt ?? calls[0]?.calledAt ?? record.startedAt);
    if (!initializedAsCancelled) {
      errors.push('fixture_premise_mismatch: REAL-085 question starts after cancellation in needs_review, but saved fixture initialized an authorized running run/lease');
      diagnostics.fixturePremiseMismatch = { expected: { runStatus: 'needs_review', leasePhase: 'needs_review', executionAuthorityRevoked: true },
        observed: { runStatus: before.run.status, leasePhase: before.lease.phase, leaseUntil: before.lease.lease_until, firstReviewStatus: firstRead?.status, firstReviewReviewable: firstRead?.reviewable }, producerServiceFailureRetained: true };
    }
    const setupReceipt = stored['setup-cancellation.json'];
    const setupCancellationVerified = metadata.fixtureContractVersion !== 'platform-eval-v2-workflow.v2' || setupReceipt
      && setupReceipt.formalService === 'cancelWorkRun' && setupReceipt.commandId === metadata.setupCancellationCommandId && setupReceipt.result?.runId === metadata.runId
      && setupReceipt.result?.status === 'needs_review' && setupReceipt.result?.changed === true && equal(setupReceipt.result, before.setupCancellation?.result)
      && equal(setupReceipt.runReview, before.setupRunReview) && setupReceipt.runReview?.reviewable === true && setupReceipt.runReview?.status === 'needs_review'
      && equal(setupReceipt.outboxReview, before.setupOutboxReview) && setupReceipt.outboxReview?.status === 'unknown'
      && after.events.some(event => event.type === 'run_needs_review' && event.metadata?.commandId === metadata.setupCancellationCommandId);
    const unknownReviewEvidence = before.outbox.status === 'unknown' && before.run.status === 'needs_review' && before.lease.phase === 'needs_review';
    check('state.0', 'lease_snapshot', initializedAsCancelled && unknownReviewEvidence && setupCancellationVerified && after.lease.phase !== 'running' && Date.parse(after.lease.lease_until) <= Date.parse(record.finishedAt),
      { initialStateMatchesQuestion: initializedAsCancelled, originalProducerState0: record.workflow.assertions?.find(item => item.id === 'state.0')?.passed ?? null,
        setupCancellationVerified: Boolean(setupCancellationVerified), specificCancelOrResolveUnknownModelCallNotRequired: true, firstRunReviewStatus: firstRead?.status, finalRunStatus: after.run.status, finalLeasePhase: after.lease.phase });
    check('state.1', 'effect_receipt', after.attempt.status === 'sent' && after.attempt.provider_receipt?.provider === 'isolated_local_file_delivery' && after.providerReceipt.sendCount === 1 && observed('readSandboxSendReceipt').some(c => c.ok) && observed('resolveWorkOutbox').some(c => c.result?.status === 'sent'));
    diagnostics.answerEvidenceRisk = { formallyObservedRunStatus: firstRead?.status ?? null, cancellationEventObserved: after.events.some(event => event.type === 'run_needs_review'),
      modelCancellationCallObserved: observed('cancelWorkRun').some(call => call.ok), setupCancellationVerified: Boolean(setupCancellationVerified),
      assessment: initializedAsCancelled ? 'Cancellation was completed by setup; the answer judge must assess observed needs_review and unknown outbox separately from later resolution. No repeated cancellation or unknown-resolution call is required.'
        : 'The separate answer judge must retain any claimed cancellation or revoked authority that contradicts the formal running/reviewable:false receipt; fixture_error does not validate that claim.' };
  } else if (id === 'REAL-089') {
    const stable = after.laterReads.find(read => read.input.documentId === metadata.ids.A && read.input.offset > 0 && read.result.data?.status === 'read' && read.result.data.content.includes('关键结论'));
    const changed = after.laterReads.find(read => read.input.documentId === metadata.ids.B && read.input.offset > 0 && read.result.data?.status === 'version_changed');
    check('state.0', 'tool_receipt', stable);
    check('state.1', 'content_hash', stable && stable.input.expectedHash === after.firstReads[metadata.ids.A]?.data.contentHash && before.hashes[metadata.ids.A] === after.hashes[metadata.ids.A] && changed && changed.input.expectedHash === after.firstReads[metadata.ids.B]?.data.contentHash && before.hashes[metadata.ids.B] !== after.hashes[metadata.ids.B]);
  } else if (id === 'REAL-094') {
    const [failed, , unrelated, repaired] = before, shownIds = after.pages.flatMap(page => page.runs ?? []).map(run => run.id);
    check('state.0', 'timeline_page', after.pages.some(page => page.coverage?.hasMore) && shownIds.includes(unrelated.id) && shownIds.includes(repaired.id) && after.pages.every(page => page.loopId === metadata.loopId));
    const reads = after.reads.filter(c => c.ok && c.result.status === 'read');
    const contentFor = run => { const read = reads.find(item => item.params.runId === run.id); if (!read) return null; try { return JSON.parse(read.result.content).fields.verificationResult; } catch { return null; } };
    const failedVerification = failed.verification, repairedVerification = contentFor(repaired), unrelatedVerification = contentFor(unrelated);
    diagnostics.modelEvidenceCoverage = { r1ReadByModel: Boolean(contentFor(failed)), unrelatedVerificationReadByModel: Boolean(unrelatedVerification), repairedVerificationReadByModel: Boolean(repairedVerification),
      serviceComparisonBaselineSource: 'hashed_before.json_actual_fixture_snapshot', r1MissingReadDoesNotProveModelFailureWasExplained: true };
    check('state.1', 'verification_result', failedVerification?.passed === false && repairedVerification?.passed === true && repairedVerification.target === failedVerification.target && repairedVerification.inputVersion === failedVerification.inputVersion && repairedVerification.expectedHash === failedVerification.expectedHash && repairedVerification.observedHash === repairedVerification.expectedHash,
      { r1ReadByModel: Boolean(contentFor(failed)), modelReasoningRequiresSeparateAnswerJudgment: true });
    const noMapping = after.runtime.some(row => row.status === 'no_active_linked_execution_observed' && row.linkedExecution === null), sourceFault = after.runtime.some(row => row.status === 'source_error' && row.currentActivity === 'unknown');
    check('state.2', 'runtime_observation', noMapping || sourceFault, { noMappingObserved: noMapping, sourceFaultObserved: sourceFault, fixtureUsesDisjunction: true, unknownActivityConclusionRequiresSeparateAnswerJudgment: true });
  } else if (id === 'REAL-100') {
    check('state.0', 'loop_snapshot', after.loop.status === 'paused' && after.loop.user_id === owner && observed('pauseLoop').some(c => c.ok) && observed('refreshLoopAndHistory').some(c => c.ok));
    const clockInitialized = before.clockInitial?.function_schema === 'public' && before.clockInitial.database === isolation.database && before.clockInitial.adapter_version === 'platform-eval-v2.clock.v1'
      && Date.parse(before.clockInitial.observed_at) < Date.parse(metadata.futureSlot) && before.clockInitial.applicationAdapterClock?.database === isolation.database
      && before.clockInitial.applicationAdapterClock.function_schema === 'public' && before.clockInitial.applicationAdapterClock.observed_at === before.clockInitial.observed_at;
    const probeCalls = observed('observeNextScheduleAdmission');
    const trace = after.scheduler.find(item => probeCalls.some(call => call.ok && equal(call.result, item)) && item.slot === metadata.futureSlot && item.previouslyAccepted === false && item.formalService === 'dispatchScheduledWorkLoop' && item.receipt.state === 'paused'
      && item.priorAdmission.workRunCount === 0 && item.priorAdmission.loopRunCount === 0 && item.priorAdmission.executionCount === 0
      && item.beforeCount === item.afterCount && item.eventsBefore === item.eventsAfter && item.clockAfterAdvance.function_schema === 'public'
      && item.clockAfterAdvance.database === isolation.database && item.clockAfterAdvance.adapter_version === 'platform-eval-v2.clock.v1'
      && item.clockAfterAdvance.function_definition_hash === before.clockInitial?.function_definition_hash
      && Date.parse(item.clockAfterAdvance.observed_at) >= Date.parse(item.slot) && item.clockAfterAdvance.applicationAdapterClock?.database === isolation.database
      && item.clockAfterAdvance.applicationAdapterClock.function_schema === 'public' && item.clockAfterAdvance.applicationAdapterClock.observed_at === item.clockAfterAdvance.observed_at);
    const admissionVerified = Boolean(clockInitialized && trace && before.runs.length === after.runs.length && after.clock?.observed_at === trace.clockAfterAdvance.observed_at);
    check('state.1', 'scheduler_trace', admissionVerified,
      { clockInitialized, probeCallObserved: probeCalls.length > 0, clockAdvanceVerified: admissionVerified, newSlotAdmissionObserved: admissionVerified,
        coverage: admissionVerified ? 'controlled_DB_clock_advanced_then_fresh_slot_paused_authority_gate; scheduler_time_computation_branch_not_reached' : probeCalls.length ? 'probe_observed_without_verified_fresh_slot_admission' : 'no_probe_observed' });
    if (!clockInitialized) errors.push('REAL-100 lacks an initialized isolated controlled clock receipt');
    check('state.2', 'history_snapshot', before.runs.some(run => run.id === metadata.previousRunId) && after.runs.some(run => run.id === metadata.previousRunId && run.status === 'completed') && before.artifactHash === after.artifactHash);
  } else return { adapterId, status: 'fixture_error', checks, errors: [...errors, 'No independent verifier for workflow'], requiresAnswerJudgment: true };
  let cleanup;
  try { cleanup = JSON.parse(await readFile(resolve(directory, 'cleanup.json'), 'utf8')); } catch { errors.push('Missing cleanup receipt'); }
  if (record.workflow?.cleanup?.status !== 'completed' || cleanup?.status !== 'completed' || cleanup.databaseDropped !== true || cleanup.fixtureFilesRemoved !== true) errors.push('Isolated fixture cleanup incomplete');
  return { adapterId, status: errors.length ? 'fixture_error' : checks.length && checks.every(item => item.passed) ? 'passed' : 'failed', checks, serviceChecks: checks,
    errors, diagnostics, receipts, requiresAnswerJudgment: true, answerAssertionIds: id === 'REAL-048' ? ['state.1'] : [], ignoredSelfReportedAssertions: true };
}
