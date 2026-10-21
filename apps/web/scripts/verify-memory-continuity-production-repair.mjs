/** Independent file-only production audit; no HTTP, model, database, or domain execution. */
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { repository, readJson, writeOnce, digest, fileHash, inside, BUDGET, ROUNDS, assertAnchor, anchorPath, assertSources, assertBuild,
  verifyPreserved, expectedState, originalState, snapshotLoop, assertProductionPreflight, childRunId, ownRunEvent } from './prove-memory-continuity-production-repair.mjs';
import { same, inputTextParts, embeddedObjects, continuityFromPayload, continuityAuditResult, verifyDispatchOrder } from './lib/memory-continuity-verification.mjs';
import { exactFreshRetryCheckpoint, exactEvidenceCallBinding, verifiedEvidenceExpansion } from './verify-memory-continuity-followup.mjs';
import { currentCorrectionQualifiers, completedEvidenceResultOrder, freshSourceCheckpoint } from './verify-memory-continuity-resume.mjs';

const optional = path => existsSync(path) ? readJson(path) : null;
const runId = round => round?.intent?.expectedRunId ?? round?.result?.loopRunId;
const adapted = (round, plan) => ({ events: round.events, providerRequests: round.providerRequests, result: { loopRunId: runId(round) }, before: { workshopId: plan.identity.workshopId, loopId: plan.identity.loopId } });
const mutations = round => (round.events ?? []).filter(event => ['working_memory_updated', 'working_memory_restored', 'working_memory_continuity_loaded'].includes(event.type)
  && event.metadata?.receiptAuthority === 'runtime').sort((a, b) => a.seq - b.seq);
export function sameActualProductionProvider(payload, request, provider) {
  return typeof provider.actualModel === 'string' && provider.actualModel.length > 0 && Array.isArray(payload.messages)
    && ['anthropic-messages', 'openai-completions'].includes(provider.protocol) && request.protocol === provider.protocol
    && payload.model === provider.actualModel && request.model === provider.actualModel && request.endpointHash === provider.actualEndpointHash;
}
/** Normalize only actual provider history envelopes; never invent a call or result. */
export function actualToolHistory(payload) {
  const calls = new Map(), results = [];
  for (const message of payload.messages ?? []) {
    if (message.role === 'assistant') {
      for (const call of message.tool_calls ?? []) calls.set(call.id, call);
      if (Array.isArray(message.content)) for (const block of message.content) if (block.type === 'tool_use') calls.set(block.id, { id: block.id, name: block.name, arguments: block.input });
    }
    if (message.role === 'tool') results.push({ toolCallId: message.tool_call_id, content: message.content });
    if (message.role === 'user' && Array.isArray(message.content)) for (const block of message.content) if (block.type === 'tool_result') results.push({ toolCallId: block.tool_use_id, content: block.content });
  }
  return { calls, results };
}
export function eventsBeforeDeadline(events, deadline) {
  const terminal = (events ?? []).filter(event => ['agent_runtime_terminal', 'loop_run_completed', 'run_completed'].includes(event.type));
  return terminal.length === 3 && terminal.every(event => Number.isFinite(Date.parse(event.createdAt)) && Date.parse(event.createdAt) <= Date.parse(deadline));
}
/** Work finalization and native Loop audit have distinct, documented execution envelopes. */
export function executionEventBound(event, expected) {
  const execution = event.metadata?.execution;
  if (!execution) return true;
  if (!Number.isSafeInteger(expected.fencingToken) || expected.fencingToken < 1 || execution.token !== expected.fencingToken || execution.workerId !== expected.workerId) return false;
  if (execution.runId === expected.runId) return true;
  const record = event.type === 'brain_record_written' && event.metadata.recordType === 'context_log'
    && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(event.metadata.recordId ?? '');
  return (event.type === 'run_completed' || record) && event.runId === expected.runId && event.loopId == null && event.loopRunId == null
    && execution.runId === undefined && same(Object.keys(execution).sort(), ['token', 'workerId']) && event.metadata.actorId === expected.userId;
}

/** A recursive exact parent proof, bounded by the production runtime's maximum eight inherited hops. */
export function exactProductionParent(checkpoint, previous, roundsById, plan, visited = new Set()) {
  if (!checkpoint || !previous || visited.size > 8 || visited.has(runId(previous))) return false;
  visited.add(runId(previous));
  const latest = mutations(previous).at(-1);
  if (latest?.type === 'working_memory_updated') return exactFreshRetryCheckpoint(checkpoint, adapted(previous, plan));
  if (latest?.type !== 'working_memory_continuity_loaded' || latest.metadata.status !== 'inherited'
    || latest.metadata.currentRunId !== runId(previous)) return false;
  const parentId = previous.before?.state?.stateJson?.lastLoopRunId ?? snapshotLoop(previous.before)?.stateJson?.lastLoopRunId;
  const parent = roundsById.get(parentId);
  if (!exactProductionParent(latest.metadata.checkpoint, parent, roundsById, plan, visited)) return false;
  const expected = structuredClone(latest.metadata.checkpoint);
  if (!expected.chain || expected.chain.depth >= 8) return false;
  expected.chain.depth += 1; expected.chain.viaRunIds.push(runId(previous));
  return same(checkpoint, expected);
}
function completedProductionExecution(round, plan) {
  const id = runId(round), loop = snapshotLoop(round?.after), durable = loop?.stateJson;
  const summary = loop?.runs?.find(item => item.id === id), persisted = round?.run?.data?.run;
  const completed = round?.events?.filter(event => event.type === 'loop_run_completed' && event.loopRunId === id) ?? [];
  const observed = round?.events?.filter(event => event.type === 'agent_runtime_terminal' && event.metadata?.receiptAuthority === 'runtime') ?? [];
  const receipt = observed.length === 1 ? observed[0] : null, terminal = receipt?.metadata?.runtimeTerminal;
  const full = round?.workerRun, trace = full?.verificationResult?.executionTrace, budget = trace?.events?.filter(event => event.type === 'budget_configured') ?? [];
  const finalTrace = round?.events?.filter(event => event.metadata?.runtimeTrace && ['completed', 'error', 'budget_exceeded'].includes(event.metadata.traceType)) ?? [];
  const workComplete = round?.events?.filter(event => event.type === 'run_completed' && event.runId === id) ?? [];
  const claimed = round?.events?.filter(event => event.type === 'execution_claimed' && event.runId === id) ?? [];
  return round?.cancellation === null && persisted?.id === id && persisted.status === 'completed' && !persisted.error
    && round.httpDetailTraceIsComplete === false && full?.schemaVersion === 'memory-production-worker-run.v1' && full.runId === id && full.loopId === plan.identity.loopId && full.status === 'success'
    && full.verificationHash === digest(full.verificationResult) && full.authority?.kind === 'read_only_existing_owner_services_from_observed_server_lease'
    && full.authority.userId === plan.identity.userId && full.authority.workshopId === plan.identity.workshopId && full.authority.runId === id && full.authority.workerId === round.intent.binding.workerInstanceId
    && full.bootId === round.intent.binding.workerBootId && full.pid === round.intent.binding.workerPid && full.planHash === digest(plan) && same(full.sourceHashes, plan.sourceHashes)
    && full.outputSummary?.trim() === persisted.outputSummary?.trim()
    && typeof persisted.outputSummary === 'string' && persisted.outputSummary.trim().length > 0 && !round.run.data.truncatedFields?.includes('run.outputSummary')
    && summary?.status === 'success' && summary.verificationPassed === true && summary.checkerAction === 'complete' && !summary.denied && !summary.requiresApproval && !summary.actionGuardBlocked
    && completed.length === 1 && completed[0].metadata.status === 'success' && completed[0].body === persisted.outputSummary
    && workComplete.length === 1 && workComplete[0].body === persisted.outputSummary && claimed.length === 1
    && claimed[0].metadata.workerId === round.intent.binding.workerInstanceId && claimed[0].metadata.fencingToken === receipt?.metadata.execution?.token
    && workComplete[0].metadata.execution?.workerId === round.intent.binding.workerInstanceId
    && durable?.lastLoopRunId === id && durable.lastJobStatus === 'success' && durable.lastVerificationPassed === true && durable.lastCheckerPassed === true
    && durable.lastOutcomeAction === 'complete' && durable.lastAttemptsUsed === 1 && loop.currentPhase === 'idle' && loop.blockedReason === null
    && budget.length === 1 && budget[0].status === 'completed' && budget[0].metadata?.maxToolCalls === 12 && trace.maxToolCalls === 12 && trace.budgetExceeded === false
    && Number.isSafeInteger(trace.toolCallCount) && trace.toolCallCount <= 12 && !trace.events.some(event => ['error', 'budget_exceeded'].includes(event.type))
    && finalTrace.length === 1 && finalTrace[0].metadata.traceType === 'completed' && finalTrace[0].metadata.traceStatus === 'completed'
    && receipt?.metadata.ordinal === 1 && receipt.metadata.currentRunId === id && receipt.runId === id && receipt.loopRunId === id
    && receipt.workshopId === plan.identity.workshopId && receipt.loopId === plan.identity.loopId
    && same(receipt.metadata.scope, { kind: 'loop', loopId: plan.identity.loopId })
    && receipt.metadata.runtime?.engine === 'pi' && receipt.metadata.runtime.adapter === 'pi-agent-harness' && typeof receipt.metadata.runtime.version === 'string'
    && terminal?.schemaVersion === 'agent-runtime-terminal.v1' && terminal.status === 'completed' && terminal.cleanupStatus === 'completed'
    && terminal.completionScope === 'runtime' && !terminal.error && (terminal.runtimeStatus === undefined || terminal.runtimeStatus === 'completed')
    && trace.runtimeTerminalCount === 1 && same(trace.runtimeTerminal, terminal)
    && trace.events.filter(event => event.type === 'agent_runtime_terminal').length === 1
    && trace.events.some(event => event.type === 'agent_runtime_terminal' && event.status === 'completed' && same(event.metadata?.runtimeTerminal, terminal))
    && Number.isSafeInteger(receipt.seq) && receipt.seq < completed[0].seq && Date.parse(receipt.createdAt) <= Date.parse(completed[0].createdAt)
    && Date.parse(persisted.completedAt) >= Date.parse(completed[0].createdAt)
    && receipt.metadata.execution?.workerId === round.intent.binding.workerInstanceId && completed[0].metadata.execution?.workerId === round.intent.binding.workerInstanceId;
}
export function completedProductionTask(round, plan) {
  return round?.failure === null && completedProductionExecution(round, plan);
}

export const CUMULATIVE_BUDGET = Object.freeze({ maximumDomainAttempts: 4, maximumProviderRequests: 58,
  priorDomainAttempts: 1, priorProviderRequests: 10, newPhaseMaximumDomainAttempts: 3, newPhaseMaximumProviderRequests: 48, automaticRetry: false });
export function withinCumulativeBudget(value, { priorDomains, priorRequests, newDomains, newRequests, spooledRequests }) {
  return same(value, CUMULATIVE_BUDGET) && priorDomains === 1 && priorRequests === 10
    && [newDomains, newRequests, spooledRequests].every(number => Number.isSafeInteger(number) && number >= 0)
    && newDomains <= 3 && priorDomains + newDomains <= 4 && newRequests <= 48 && spooledRequests === newRequests && priorRequests + newRequests <= 58;
}

export function pilotFailurePreserved(round, review) {
  return round?.round === 'P1' && round.events?.length === 0 && round.after === null
    && round.failure?.message === 'Own-run event pagination mismatch' && review?.passed === false
    && review.mechanismPassed === false && review.roundAcceptance?.P1?.attempted === true
    && review.roundAcceptance.P1.mechanismPassed === false && review.roundAcceptance?.P2?.attempted === false
    && review.roundAcceptance?.P3?.attempted === false;
}
export function pilotAuxiliaryFailure(events, requests) {
  const quality = events.filter(event => event.type === 'report_quality_review');
  return quality.length === 1 && quality[0].metadata?.evaluatorMode === 'rule_based'
    && quality[0].metadata.semanticReviewStatus === 'not_completed' && quality[0].metadata.degraded === true
    && quality[0].metadata.error === 'Production acceptance budget exhausted before transmission'
    && requests.length === 10 && requests.filter(request => request.kind === 'recall-planner').length === 1
    && requests.filter(request => request.kind === 'working-memory-agent').length === 9
    && requests.every(request => request.responseStatus === 200 && request.error === null);
}

/** A saved failed collector can supply a separately proven memory parent. Its
 * original verdict, failure, budget and bytes remain immutable. No HTTP/DB/model. */
export function verifyParentPilot({ directory, supplementFile, failedReviewFile, root = repository }) {
  const checks = [], preservedFiles = {};
  const check = (name, value) => checks.push({ name, passed: value === true });
  const load = filename => { const value = readJson(filename); preservedFiles[resolve(filename)] = fileHash(filename); return value; };
  try {
    const plan = load(resolve(directory, 'production-session.json')), round = load(resolve(directory, 'round-P1.json'));
    const intent = load(resolve(directory, 'round-P1-intent.json')), supplement = load(supplementFile), review = load(failedReviewFile);
    const id = runId(round), events = supplement.pages?.flatMap(page => page.data?.events ?? []) ?? [];
    check('original failed production P1 collector and strict review remain failed', pilotFailurePreserved(round, review)
      && review.planHash === digest(plan) && same(round.intent, intent) && intent.planHash === digest(plan)
      && !['P2', 'P3'].some(name => existsSync(resolve(directory, `round-${name}-intent.json`)) || existsSync(resolve(directory, `round-${name}.json`))));
    check('supplement is explicit read-only observation of the original plan', supplement.schemaVersion === 'memory-production-http-supplement.v1'
      && supplement.modelCalls === 0 && supplement.domainAttempts === 0 && supplement.originalRound === 'round-P1.json' && same(supplement.plan, plan)
      && supplement.pages.length > 0 && supplement.pages.every(page => page.status === 200 && page.data.events.length < 2000));
    const claim = events.filter(event => event.type === 'execution_claimed');
    const authority = { runId: id, userId: plan.identity.userId, workerId: intent.binding.workerInstanceId, fencingToken: claim.length === 1 ? claim[0].metadata?.fencingToken : null };
    check('all supplemented own-run events are complete ordered and fenced', events.length > 0 && new Set(events.map(event => event.id)).size === events.length
      && events.every((event, index) => ownRunEvent(event, plan.identity, id, { token: authority.fencingToken, workerId: authority.workerId }) && !event.metadata?.__truncated
        && Number.isSafeInteger(event.seq) && (!index || event.seq > events[index - 1].seq) && executionEventBound(event, authority)));
    const full = load(resolve(directory, 'spool', 'P1-worker-run.json'));
    check('raw original worker trace remains exact', same(full, round.workerRun));
    let productionBound = false;
    try { productionBound = same(assertProductionPreflight(plan, round.before, round.deployment, round.boots), intent.binding)
      && same(assertProductionPreflight(plan, supplement.snapshot, round.deployment, round.boots), intent.binding); } catch { /* Incomplete process identity is a failed parent proof. */ }
    check('original production process build scope and live lease were actually bound', productionBound);
    let requestFilesExact = round.providerRequests.length === 10;
    for (const request of round.providerRequests) {
      const path = inside(directory, resolve(directory, request.requestBodyFile));
      const captured = load(path), response = load(path.replace('.request.json', '.response.json'));
      requestFilesExact &&= digest(captured.payload) === request.payloadHash
        && same({ ...captured, requestBodyFile: request.requestBodyFile, ...response }, request)
        && request.planHash === digest(plan) && request.bootId === intent.binding.workerBootId && request.pid === intent.binding.workerPid
        && request.authority?.userId === plan.identity.userId && request.authority.workshopId === plan.identity.workshopId
        && request.authority.runId === id && request.authority.workerId === intent.binding.workerInstanceId;
    }
    check('all ten physical provider requests bind exact saved payload response and worker', requestFilesExact);
    const evidence = { ...round, events, after: supplement.snapshot };
    check('physical production execution completed without changing the collector verdict', completedProductionExecution(evidence, plan));
    check('original ten-request budget was exhausted before quality transmission and remains failed', pilotAuxiliaryFailure(events, round.providerRequests));
    const main = round.providerRequests.filter(request => request.kind === 'working-memory-agent');
    check('original production budget and complete main dispatch receipts', round.budget.maxRequests === 10 && round.budget.maxToolCalls === 12 && round.budget.maxSeconds === 360
      && Date.parse(intent.deadlineAt) - Date.parse(intent.createdAt) === 360000 && eventsBeforeDeadline(events, intent.deadlineAt)
      && main.every(request => sameActualProductionProvider(request.payload, request, plan.provider))
      && verifyDispatchOrder({ events, providerRequests: round.providerRequests, before: plan.identity, result: { loopRunId: id } }).passed);
    const resume = load(resolve(plan.parent.directory, 'resume-session.json'));
    const parents = ['R1', 'R2', 'R3'].map(name => load(resolve(plan.parent.directory, `round-${name}.json`)));
    const correction = load(resolve(root, resume.priorCampaign.directory, 'correction.json'));
    const corrected = { ...correction, expectedVersion: plan.correction.expectedVersion }, originalId = correction.result.oldMemory.id;
    const byId = new Map(parents.map(parent => [runId(parent), parent]));
    const inherited = events.filter(event => event.type === 'working_memory_continuity_loaded' && event.metadata?.receiptAuthority === 'runtime');
    const receipt = inherited.length === 1 ? inherited[0] : null, checkpoint = receipt?.metadata.checkpoint;
    check('P1 inherits exact recursively verified R3 checkpoint', receipt?.metadata.status === 'inherited' && receipt.metadata.currentRunId === id
      && same(receipt.metadata.scope, { kind: 'loop', loopId: plan.identity.loopId }) && exactProductionParent(checkpoint, parents.at(-1), byId, plan)
      && main.length > 0 && main.map(request => continuityFromPayload(request.payload)).every(group => group.length === 1 && same(group[0], continuityAuditResult(receipt.metadata))));
    const canonical = round.before?.revision?.data?.memory;
    check('all original main inputs preserve current correction and suppress old claims', main.length > 0 && main.every(request => {
      const contexts = inputTextParts(request.payload).flatMap(text => embeddedObjects(text, 'Workshop context:')).filter(context => context.workshop?.id === plan.identity.workshopId);
      return contexts.length === 1 && currentCorrectionQualifiers(contexts[0], corrected, originalId, canonical);
    }) && receipt?.metadata.claimGuard?.suppressHistoricalClaims === true && checkpoint?.chain?.assertionsSuppressed === true
      && checkpoint.history?.facts?.length === 0 && checkpoint.history.hypotheses?.length === 0 && checkpoint.history.nextAction === null && checkpoint.sourceRefs?.length === 0);
    const adaptation = adapted(evidence, plan);
    check('P1 saved a genuine new production source-bound checkpoint', freshSourceCheckpoint(adaptation));
    const assertions = correction.evaluationAssertions, output = round.run?.data?.run?.outputSummary ?? '';
    check('actual original output retains the current owner assertion only', assertions?.outputIncludes?.length > 0 && assertions.outputExcludes?.length > 0
      && assertions.outputIncludes.every(text => output.includes(text)) && assertions.outputExcludes.every(text => !output.includes(text)));
    check('P1 parent scope and version exactly match its immutable plan', id === intent.expectedRunId
      && id === childRunId(plan.identity.userId, plan.identity.workshopId, intent.commandId)
      && snapshotLoop(supplement.snapshot)?.stateJson?.lastLoopRunId === id
      && supplement.snapshot?.revision?.data?.expectedVersion === plan.correction.expectedVersion
      && digest(supplement.snapshot.revision.data.memory.content) === plan.correction.contentHash
      && supplement.snapshot.revision.data.memory.confidence === 25 && supplement.snapshot.revision.data.memory.status === 'active');
    return { passed: checks.every(item => item.passed), checks, plan, round, snapshot: supplement.snapshot, events, runId: id,
      requestCount: round.providerRequests.length, domainAttempts: 1, preservedFiles, auxiliaryHealthPassed: false, originalCampaignPassed: false,
      sourceBoundSaveRound: 'P1', evidenceBoundary: 'Supplemented observation qualifies only the completed execution and memory parent. Original collector and quality failures remain failed.' };
  } catch (error) { return { passed: false, checks: [...checks, { name: 'complete parent pilot artifacts are readable', passed: false }], errorClass: error?.code ?? error?.name ?? 'unknown_error', preservedFiles }; }
}
export function healthyAuxiliaries(contexts, events, requests) {
  const plans = contexts.map(context => context.memoryRecall?.recallPlan), reviews = events.filter(event => event.type === 'report_quality_review');
  const aux = requests.filter(request => request.kind !== 'working-memory-agent');
  const terminal = provider => provider?.protocol === 'openai-completions' ? provider.finishReason === 'stop'
    : provider?.protocol === 'anthropic-messages' && ['end_turn', 'stop_sequence'].includes(provider.finishReason);
  return contexts.length > 0 && plans.every(plan => plan?.mode === 'llm' && terminal(plan.provider))
    && reviews.length === 1 && reviews[0].metadata.evaluatorMode === 'llm' && reviews[0].metadata.semanticReviewStatus === 'completed'
    && reviews[0].metadata.degraded === false && terminal(reviews[0].metadata.provider)
    && aux.length >= 2 && aux.some(request => request.kind === 'recall-planner') && aux.some(request => request.kind === 'auxiliary-model')
    && aux.every(request => request.responseStatus === 200 && request.error === null && request.responseSummary?.validJsonResponse === true
      && request.responseSummary.providerError === false
      && (request.responseSummary.finishReasons?.length > 0 ? request.responseSummary.finishReasons.every(reason => reason === 'stop')
        : ['end_turn', 'stop_sequence'].includes(request.responseSummary.stopReason)));
}
function objects(content, depth = 0) {
  if (depth > 5 || content == null) return [];
  if (typeof content === 'string') { try { return objects(JSON.parse(content), depth + 1); } catch { return []; } }
  if (Array.isArray(content)) return content.flatMap(value => objects(value, depth + 1));
  return typeof content === 'object' ? [content, ...objects(content.text, depth + 1), ...objects(content.content, depth + 1), ...objects(content.data, depth + 1)] : [];
}
export function auditProduction({ root = repository, directory }) {
  const plan = readJson(resolve(directory, 'production-session.json')), checks = [], missingEvidence = [], artifactHashes = {}, roundAcceptance = {}, usage = [], evidenceProof = [], dependencyWarnings = [], requestFailures = [];
  const check = (name, passed, detail = null) => checks.push({ name, passed: passed === true, detail });
  const attempt = (name, operation) => { try { operation(); check(name, true); } catch (error) { check(name, false, error.message); } };
  const recordHash = path => { artifactHashes[resolve(path)] = fileHash(path); };
  recordHash(resolve(directory, 'production-session.json'));
  check('independent auditor version matches explicit production plan', fileHash(resolve(root, 'apps/web/scripts/verify-memory-continuity-production-repair.mjs')) === plan.auditorHash);
  attempt('fixed unique production phase anchor and unchanged caps', () => assertAnchor(readJson(anchorPath(root)), plan, directory));
  attempt('all original failures and R1-R3 artifacts remain immutable', () => verifyPreserved(plan));
  attempt('current production runtime and runner match frozen source version', () => assertSources(root, plan.sourceHashes));
  attempt('production build ID and manifests remain frozen', () => assertBuild(root, plan.build));
  const buildReceipt = readJson(plan.buildReceipt.filename);
  check('actual successful Next build source freeze and output manifests bind this plan', fileHash(plan.buildReceipt.filename) === plan.buildReceipt.hash
    && buildReceipt.schemaVersion === 'memory-production-build.v1' && buildReceipt.passed === true && buildReceipt.exitCode === 0 && buildReceipt.sourceDrift?.length === 0
    && buildReceipt.buildId === plan.build.buildId && resolve(root, buildReceipt.buildDirectory) === plan.build.directory
    && Object.entries(buildReceipt.sourceHashes ?? {}).length > 0 && Object.entries(buildReceipt.sourceHashes).every(([path, hash]) => plan.sourceHashes[path] === hash)
    && Object.entries(buildReceipt.manifestHashes).every(([path, hash]) => plan.build.hashes[path] === hash));
  const pilot = verifyParentPilot({ directory: plan.parent.directory, supplementFile: plan.parent.supplementFile, failedReviewFile: plan.parent.reviewFile, root });
  check('original failed P1 is independently eligible only as execution and memory parent', pilot.passed);
  if (!pilot.passed) throw Error('Original production P1 parent proof failed');
  Object.assign(artifactHashes, pilot.preservedFiles);
  check('exact immutable pilot plan round intent supplement and failed-review references', plan.parent.planHash === fileHash(resolve(plan.parent.directory, plan.parent.planFile))
    && plan.parent.roundHash === fileHash(resolve(plan.parent.directory, plan.parent.roundFile))
    && plan.parent.intentHash === fileHash(resolve(plan.parent.directory, plan.parent.intentFile))
    && plan.parent.supplementHash === fileHash(plan.parent.supplementFile) && plan.parent.reviewHash === fileHash(plan.parent.reviewFile)
    && plan.parent.runId === pilot.runId && same(plan.cumulativeBudget, CUMULATIVE_BUDGET));
  const oldPlan = readJson(resolve(pilot.plan.parent.directory, 'resume-session.json'));
  const profile = readJson(plan.providerProfile.filename);
  check('fresh source-bound canonical provider migration is explicit and immutable', profile.schemaVersion === 'memory-production-provider-profile.v1' && fileHash(plan.providerProfile.filename) === plan.providerProfile.hash
    && profile.credentialValuesOrHashesRecorded === false && profile.sourceBinding?.status === 'matched' && profile.configuredWorkLoopMatchesParent === true && profile.modelConfigurationMatchesParent === true
    && profile.modelHttp?.fetchBlocked === true && profile.modelHttp.attemptedFetches === 0
    && profile.actualModel === plan.provider.actualModel && profile.actualEndpointHash === plan.provider.actualEndpointHash && profile.protocol === plan.provider.protocol
    && Object.entries(profile.sourceBinding.sourceHashes ?? {}).length > 0 && Object.entries(profile.sourceBinding.sourceHashes).every(([path, hash]) => plan.sourceHashes[path] === hash));
  check('same original owner Work Loop task configuration provider correction', ['userId', 'workshopId', 'loopId', 'goalHash', 'modelConfigHash', 'loopConfigurationHash'].every(key => oldPlan.initial[key] === plan.identity[key])
    && plan.provider.actualModel === oldPlan.provider.actualModel && same(plan.providerMigration?.previous, oldPlan.provider)
    && plan.providerMigration.previousPayloadsRewritten === false && plan.providerMigration.currentProfileHash === plan.providerProfile.hash
    && same(plan.correction, oldPlan.correction) && same(plan.budget, BUDGET) && same(plan.rounds, ROUNDS));
  const originalDir = resolve(root, oldPlan.priorCampaign.directory), correction = readJson(resolve(originalDir, 'correction.json'));
  const corrected = { ...correction, expectedVersion: plan.correction.expectedVersion }, originalId = correction.result.oldMemory.id;
  const parentRounds = ['R1', 'R2', 'R3'].map(name => readJson(resolve(pilot.plan.parent.directory, `round-${name}.json`)));
  const pilotEvidence = { ...pilot.round, events: pilot.events, after: pilot.snapshot };
  const rounds = ROUNDS.map(name => optional(resolve(directory, `round-${name}.json`)));
  const byId = new Map([...parentRounds, pilotEvidence, ...rounds.filter(Boolean)].map(round => [runId(round), round]));
  const preflights = readdirSync(directory).filter(name => /^production-preflight-.*\.json$/.test(name)).sort();
  check('explicit real production HTTP preflight exists before first dispatch', preflights.length > 0);
  for (const name of preflights) {
    const receipt = readJson(resolve(directory, name)); recordHash(resolve(directory, name));
    attempt(`${name}: real managed process build worker heartbeat scope`, () => {
      if (receipt.planHash !== digest(plan)) throw Error('Wrong plan');
      const actual = assertProductionPreflight(plan, receipt.snapshot, receipt.deployment, receipt.boots);
      if (!same(actual, receipt.binding)) throw Error('Preflight process binding differs');
    });
  }
  const preflightPassed = checks.every(item => item.passed);
  for (let i = 0; i < ROUNDS.length; i++) {
    const name = ROUNDS[i], round = rounds[i], first = checks.length;
    if (!round) { missingEvidence.push(`round-${name}.json`); roundAcceptance[name] = { attempted: existsSync(resolve(directory, `round-${name}-intent.json`)), mechanismPassed: false, completeRealTask: false, missing: true }; continue; }
    recordHash(resolve(directory, `round-${name}.json`)); recordHash(resolve(directory, `round-${name}-intent.json`));
    const intent = readJson(resolve(directory, `round-${name}-intent.json`)), previous = i ? rounds[i - 1] : pilotEvidence, id = runId(round);
    check(`${name}: explicit read-only preflight preceded this domain attempt`, preflights.some(file => Date.parse(readJson(resolve(directory, file)).snapshot.observedAt) <= Date.parse(intent.createdAt)));
    check(`${name}: immutable one-attempt formal HTTP202 queue command`, same(intent, round.intent) && intent.planHash === digest(plan)
      && intent.commandId === `${plan.phase}:${name}` && id === childRunId(plan.identity.userId, plan.identity.workshopId, intent.commandId)
      && same(intent.body, { commandId: intent.commandId, expectedVersion: round.before?.workshop?.data?.commandVersion, mode: 'native_agent', wait: false, createOutboxDrafts: false })
      && round.accepted?.status === 202 && round.accepted.data.accepted === true && Object.values(round.accepted.data).includes(id));
    attempt(`${name}: before real production identity process policy`, () => assertProductionPreflight(plan, round.before, round.deployment, round.boots));
    attempt(`${name}: after real production identity process policy`, () => assertProductionPreflight(plan, round.after, round.deployment, round.boots));
    check(`${name}: exact frozen production sources and build`, same(round.sourceHashes, plan.sourceHashes) && same(round.build, plan.build));
    check(`${name}: exact durable predecessor state retained`, !!previous && same(expectedState(round.before), expectedState(previous.after))
      && (i === 0 || completedProductionTask(previous, plan)));
    check(`${name}: authentic terminal and persisted successful verified output`, completedProductionTask(round, plan));
    check(`${name}: bounded 16 requests 360 seconds 12 tools and one domain attempt`, same(round.budget, BUDGET) && same(intent.budget, BUDGET)
      && round.providerRequests.length > 0 && round.providerRequests.length <= BUDGET.maxRequests
      && Date.parse(intent.deadlineAt) - Date.parse(intent.createdAt) === BUDGET.maxSeconds * 1000
      && Date.parse(round.run?.data?.run?.completedAt) <= Date.parse(intent.deadlineAt)
      && eventsBeforeDeadline(round.events, intent.deadlineAt)
      && Date.parse(round.finishedAt) <= Date.parse(intent.deadlineAt) + 30_000 && Date.parse(intent.createdAt) < Date.parse(round.finishedAt));
    const events = round.events, seq = events.map(event => event.seq);
    const claims = events.filter(event => event.type === 'execution_claimed' && event.runId === id);
    const executionIdentity = { runId: id, workerId: intent.binding.workerInstanceId, userId: plan.identity.userId, fencingToken: claims.length === 1 ? claims[0].metadata?.fencingToken : null };
    const rawPath = resolve(directory, 'spool', `${name}-worker-run.json`);
    check(`${name}: complete untruncated worker-owned persisted trace receipt`, existsSync(rawPath) && same(readJson(rawPath), round.workerRun));
    if (existsSync(rawPath)) recordHash(rawPath);
    check(`${name}: complete monotonic own-run audit and actual runtime instance lease`, events.length > 0 && new Set(seq).size === seq.length && seq.every((value, index) => Number.isSafeInteger(value) && (!index || value > seq[index - 1]))
      && events.every(event => ownRunEvent(event, plan.identity, id, { token: executionIdentity.fencingToken, workerId: executionIdentity.workerId }) && !event.metadata?.__truncated && executionEventBound(event, executionIdentity)));
    const payloads = [], requestForPayload = new Map();
    for (const request of round.providerRequests) {
      const path = inside(directory, resolve(directory, request.requestBodyFile)), captured = readJson(path); recordHash(path);
      const responsePath = path.replace('.request.json', '.response.json');
      check(`${name} request ${request.index}: exact independently captured request and response`, existsSync(responsePath) && same(captured.payload, request.payload)
        && digest(captured.payload) === request.payloadHash && same({ ...captured, requestBodyFile: request.requestBodyFile, ...readJson(responsePath) }, request));
      if (existsSync(responsePath)) recordHash(responsePath);
      check(`${name} request ${request.index}: server-owned ALS boot worker exact scope before dispatch`, request.authority?.kind === 'server_owned_async_local_storage'
        && request.authority.userId === plan.identity.userId && request.authority.workshopId === plan.identity.workshopId && request.authority.runId === id
        && request.authority.workerId === intent.binding.workerInstanceId && request.bootId === intent.binding.workerBootId && request.pid === intent.binding.workerPid
        && request.planHash === digest(plan) && request.credentialValuesOrHashesRecorded === false && request.requestHeadersRecorded === false
        && Date.parse(request.dispatchedAt) >= Date.parse(intent.createdAt) && Date.parse(request.dispatchedAt) < Date.parse(intent.deadlineAt));
      const good = request.responseStatus === 200 && request.error === null;
      if (!good) { const failure = { round: name, index: request.index, kind: request.kind, status: request.responseStatus, errorClass: request.error }; requestFailures.push(failure); if (request.kind !== 'working-memory-agent') dependencyWarnings.push(failure); }
      if (request.kind === 'working-memory-agent') {
        payloads.push(captured.payload); requestForPayload.set(captured.payload, request);
        check(`${name} main ${request.index}: actual model endpoint protocol retained and transport successful`, good && sameActualProductionProvider(captured.payload, request, plan.provider));
      }
      const net = request.network;
      check(`${name} request ${request.index}: explicit network TLS route evidence`, net?.mode === plan.network.mode && net.preflightModelRequests === 0 && net.processEnvironmentChanged === false && net.globalDispatcherChanged === false
        && net.certificateValidation === true && net.originalHostnameAndSniPreserved === true
        && (net.mode === 'default' || net.targetOrigin === 'https://opencode.ai' && net.publicIpv4Candidates?.includes(net.selectedAddress)
          && net.preflight?.some(item => item.address === net.selectedAddress && item.transportSucceeded) && net.preferredAddress === plan.network.preferredAddress));
    }
    const mapping = verifyDispatchOrder({ events, providerRequests: round.providerRequests, before: plan.identity, result: { loopRunId: id } });
    check(`${name}: persisted prepared SDK receipt precedes exact actual dispatch`, mapping.passed, mapping.errors);
    const groups = payloads.map(payload => inputTextParts(payload).flatMap(text => embeddedObjects(text, 'Workshop context:')).filter(context => context.workshop?.id === plan.identity.workshopId));
    check(`${name}: actual registered and requested tool names retain read/log-only fixture authority`, payloads.length > 0
      && payloads.every(payload => same((payload.tools ?? []).map(tool => tool.function?.name ?? tool.name).sort(), plan.allowedTools))
      && events.filter(event => event.type === 'tool_call' && event.metadata?.runtimeTrace === true).every(event => plan.allowedTools.includes(event.metadata.toolName?.split('__').at(-1)))
      && !events.some(event => ['outbox_sent', 'outbox_draft_created', 'trade_order_placed'].includes(event.type)));
    const contexts = groups.flat(), canonical = round.before.revision.data.memory;
    check(`${name}: complete correction exact selected version true confidence status reserve warning`, payloads.length > 0 && groups.every(group => group.length === 1
      && currentCorrectionQualifiers(group[0], corrected, originalId, canonical)));
    check(`${name}: planner and quality actually completed without fallback or terminal interruption`, healthyAuxiliaries(contexts, events, round.providerRequests));
    const stateInputs = payloads.map(payload => inputTextParts(payload).flatMap(text => embeddedObjects(text, 'Current durable state:')));
    const previousState = expectedState(round.before).stateJson;
    check(`${name}: actual model uses exact latest durable feedback identity`, payloads.length > 0 && stateInputs.every(group => group.length === 1
      && ['lastLoopRunId', 'lastJobStatus', 'lastAttemptsUsed', 'lastCheckerPassed', 'lastOutcomeAction', 'lastVerificationPassed'].every(key => group[0].stateJson?.[key] === previousState?.[key])));
    const inherited = events.filter(event => event.type === 'working_memory_continuity_loaded' && event.metadata?.receiptAuthority === 'runtime');
    const receipt = inherited.length === 1 ? inherited[0] : null, checkpoint = receipt?.metadata.checkpoint;
    check(`${name}: exact recursively proven latest checkpoint in every actual model input`, receipt?.metadata.status === 'inherited' && receipt.metadata.currentRunId === id
      && same(receipt.metadata.scope, { kind: 'loop', loopId: plan.identity.loopId }) && exactProductionParent(checkpoint, previous, byId, plan)
      && payloads.length > 0 && payloads.map(continuityFromPayload).every(group => group.length === 1 && same(group[0], continuityAuditResult(receipt.metadata))));
    check(`${name}: current owner correction suppresses historical claims/actions`, receipt?.metadata.claimGuard?.suppressHistoricalClaims === true && checkpoint?.chain?.assertionsSuppressed === true
      && checkpoint.history?.facts?.length === 0 && checkpoint.history.hypotheses?.length === 0 && checkpoint.history.nextAction === null && checkpoint.history.openQuestions?.length > 0 && checkpoint.sourceRefs?.length === 0);
    const output = round.run?.data?.run?.outputSummary ?? '', includes = correction.evaluationAssertions?.outputIncludes ?? [], excludes = correction.evaluationAssertions?.outputExcludes ?? [];
    check(`${name}: actual persisted output satisfies exact original owner assertions`, includes.length > 0 && excludes.length > 0 && includes.every(text => output.includes(text)) && excludes.every(text => !output.includes(text)));
    for (const payload of payloads) {
      const { calls, results: toolResults } = actualToolHistory(payload);
      for (const message of toolResults) {
        const callsActual = events.filter(event => exactEvidenceCallBinding(calls.get(message.toolCallId), event, plan.correction.memoryId));
        const prepared = events.find(event => event.id === requestForPayload.get(payload)?.hostPrepared?.eventId);
        const results = events.filter(event => callsActual.some(call => completedEvidenceResultOrder(call, event, prepared, message.toolCallId)));
        if (callsActual.length && results.length && objects(message.content).some(result => verifiedEvidenceExpansion(result, corrected, originalId))
          && !evidenceProof.some(item => item.toolCallId === message.toolCallId)) evidenceProof.push({ round: name, toolCallId: message.toolCallId, actualCompletedTask: completedProductionTask(round, plan), mode: 'autonomous-model-tool-use' });
      }
    }
    const actualUsage = events.filter(event => event.type === 'working_memory_usage' && event.metadata?.receiptAuthority === 'runtime');
    const main = round.providerRequests.filter(request => request.kind === 'working-memory-agent'), reported = actualUsage.filter(event => event.metadata.usageStatus === 'reported' && event.metadata.source === 'sdk_result' && Number.isSafeInteger(event.metadata.totalTokens));
    const usageComplete = actualUsage.length === main.length && reported.length === main.length;
    usage.push({ round: name, providerRequests: round.providerRequests.length, mainRequests: main.length, mainSdkReceipts: actualUsage.length, reported: reported.length, unknown: actualUsage.length - reported.length,
      mainUsageComplete: usageComplete, reportedTokenSubtotal: reported.reduce((sum, event) => sum + event.metadata.totalTokens, 0), auxiliaryTokens: null, monetaryCostUsd: null });
    roundAcceptance[name] = { attempted: true, mechanismPassed: preflightPassed && checks.slice(first).every(item => item.passed), completeRealTask: completedProductionTask(round, plan), mainUsageComplete: usageComplete,
      failedChecks: checks.slice(first).filter(item => !item.passed).map(item => item.name) };
  }
  check('actual production successful task autonomously resolved typed owner correction observation', evidenceProof.some(item => item.actualCompletedTask));
  const newPhaseSavedCheckpoint = rounds.filter(Boolean).some(round => completedProductionTask(round, plan) && freshSourceCheckpoint(adapted(round, plan)));
  check('P1 independently saved a production source-bound checkpoint retained by exact Q ancestry', pilot.passed && freshSourceCheckpoint(adapted(pilotEvidence, pilot.plan)));
  const attemptedDomainCount = ROUNDS.filter(name => existsSync(resolve(directory, `round-${name}-intent.json`))).length;
  const spooledRequests = existsSync(resolve(directory, 'spool')) ? readdirSync(resolve(directory, 'spool')).filter(name => /^Q[123]-\d+\.request\.json$/.test(name)) : [];
  const chargedNewRequests = rounds.filter(Boolean).reduce((sum, round) => sum + round.providerRequests.length, 0);
  check('global original plus corrected campaign never exceeds four domains or fifty-eight requests', withinCumulativeBudget(plan.cumulativeBudget,
    { priorDomains: pilot.domainAttempts, priorRequests: pilot.requestCount, newDomains: attemptedDomainCount, newRequests: chargedNewRequests, spooledRequests: spooledRequests.length }));
  const attempted = rounds.filter(Boolean).length, mechanismPassed = missingEvidence.length === 0 && checks.every(item => item.passed), mainUsageComplete = attempted === 3 && usage.every(item => item.mainUsageComplete);
  return { schemaVersion: 'memory-production-repair-independent-review.v1', planHash: digest(plan), reviewedAt: new Date().toISOString(), status: missingEvidence.length ? 'incomplete_evidence' : mechanismPassed ? mainUsageComplete ? 'production_mechanism_verified_auxiliary_cost_unknown' : 'production_mechanism_verified_main_usage_inconclusive' : 'failed',
    passed: mechanismPassed && mainUsageComplete, mechanismPassed, preflightPassed, taskStabilityVerified: mechanismPassed, roundAcceptance, attemptedNewRounds: attempted,
    consecutiveSuccessfulNewTasks: (() => { let n = 0; for (const name of ROUNDS) { if (!roundAcceptance[name]?.completeRealTask) break; n++; } return n; })(),
    checks, missingEvidence, usage, mainUsageComplete, auxiliaryUsageComplete: false, dependencyWarnings, requestFailures, evidenceProof, artifactHashes,
    auditorHash: fileHash(resolve(root, 'apps/web/scripts/verify-memory-continuity-production-repair.mjs')),
    parentProof: { memoryOnlyParentEligible: pilot.passed, sourceBoundSaveRound: 'P1', originalCampaignPassed: false, auxiliaryHealthPassed: false,
      originalCollectorFailure: pilot.round.failure.message, checks: pilot.checks },
    cumulativeBudget: { ...CUMULATIVE_BUDGET, actualDomainAttempts: pilot.domainAttempts + attemptedDomainCount, actualProviderRequests: pilot.requestCount + chargedNewRequests },
    saveProof: { parentP1SavedCheckpoint: true, newPhaseSavedCheckpoint },
    claims: { threeBoundedProductionTasksMemoryAndAuxiliaryHealthVerified: mechanismPassed, historicalFailuresPassed: false, universalStabilityProved: false, naturalTaskQualityImproved: false, monetaryCostMeasured: false },
    evidenceBoundary: 'Actual HTTP queue, actual managed Next build and worker process, server-owned ALS lease, complete persisted events, exact private payloads. Three explicit mechanism tasks support only this bounded fixture and configuration. HTTP 200 alone is never task completion.' };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const arg = process.argv.slice(2).find(value => value.startsWith('--out=')); if (!arg) throw Error('--out required');
    const directory = resolve(arg.slice(6)), review = auditProduction({ directory });
    const path = resolve(directory, `production-repair-independent-review-${review.reviewedAt.replace(/[:.]/g, '-')}.json`); writeOnce(path, review);
    console.log(JSON.stringify({ status: review.status, preflightPassed: review.preflightPassed, mechanismPassed: review.mechanismPassed, roundAcceptance: review.roundAcceptance,
      attemptedNewRounds: review.attemptedNewRounds, failedChecks: review.checks.filter(item => !item.passed).map(item => item.name), missingEvidence: review.missingEvidence }));
    if (!review.mechanismPassed) process.exitCode = 2;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
