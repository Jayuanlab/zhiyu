/** Independent file-only audit for the explicitly authorized October 18 continuation. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { same, inputTextParts, embeddedObjects, continuityFromPayload, continuityAuditResult,
  verifyDispatchOrder, verifyPromotion, verifyReview, verifyCorrection } from "./lib/memory-continuity-verification.mjs";
import { frozenSources, exactCurrentCorrection, exactOriginalFailure, exactFreshRetryCheckpoint,
  exactEvidenceCallBinding, verifiedEvidenceExpansion } from "./verify-memory-continuity-followup.mjs";

const hash = value => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const identityKeys = ["userId", "workshopId", "loopId", "goalHash", "modelConfigHash", "loopConfigurationHash"];
const roundsPlanned = ["R1", "R2", "R3"];
export function sameActualMainIdentity(payload, request, provider) {
  return typeof provider?.actualModel === "string" && provider.actualModel.length > 0 && provider.protocol === "openai-completions"
    && payload?.model === provider.actualModel && request?.model === provider.actualModel && Array.isArray(payload.messages)
    && request.endpointHash === provider.actualEndpointHash;
}
export function completedEvidenceResultOrder(call, result, prepared, toolCallId) {
  const times = [call?.createdAt, result?.createdAt, prepared?.createdAt].map(value => Date.parse(value));
  return call?.type === "tool_call" && call.metadata?.runtimeTrace === true && call.metadata.toolUseId === toolCallId
    && result?.type === "tool_result" && result.metadata?.runtimeTrace === true && result.metadata.traceType === "tool_result"
    && result.metadata.traceStatus === "completed" && result.metadata.toolUseId === toolCallId
    && result.metadata.toolName?.split("__").at(-1) === "workshopGetMemoryEvidence"
    && prepared?.type === "working_memory_projected" && prepared.metadata?.receiptAuthority === "runtime" && prepared.metadata.status === "provider_request_prepared"
    && ["workshopId", "loopId", "loopRunId"].every(key => typeof call[key] === "string" && call[key] === result[key] && call[key] === prepared[key])
    && [call.seq, result.seq, prepared.seq].every(Number.isSafeInteger) && call.seq < result.seq && result.seq < prepared.seq
    && times.every(Number.isFinite) && times[0] <= times[1] && times[1] <= times[2];
}
export const resumeFrozenSources = hashes => Object.fromEntries(Object.entries(frozenSources(hashes))
  .filter(([path]) => !path.endsWith("scripts/verify-memory-continuity-resume.mjs")));
const sourceDifference = (before, after) => [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
  .filter(path => before[path] !== after[path]).map(path => ({ path, beforeHash: before[path] ?? null, afterHash: after[path] ?? null }));
const sameIdentity = (left, right) => identityKeys.every(key => typeof left?.[key] === "string" && left[key] === right?.[key]);
function safeName(name) {
  if (typeof name !== "string" || !/^[A-Za-z0-9_.-]+\.json$/.test(name) || name.includes("..")) throw Error("Invalid artifact filename");
  return name;
}
function optional(load, name) { try { return load(name); } catch (error) { if (error?.code === "ENOENT") return null; throw error; } }

export function preservedFailedE2(round) {
  const main = (round?.providerRequests ?? []).filter(item => item.kind === "working-memory-agent");
  const state = round?.after?.state?.stateJson;
  return round?.round === "E2" && round.failure === null && round.result?.result?.status === "error"
    && /\[data_inspection_failed\]/.test(round.result.result.error ?? "") && main.length > 0
    && main.every(item => item.responseStatus === 200 && item.error === null)
    && round.events?.some(event => event.type === "tool_error" && event.body?.includes("data_inspection_failed"))
    && state?.lastLoopRunId === round.result.loopRunId && state.lastJobStatus === "error"
    && state.lastVerificationPassed === false && state.lastCheckerPassed === false && state.lastOutcomeAction === "fail" && state.lastAttemptsUsed === 1;
}

export function currentCorrectionQualifiers(context, correction, originalId, canonical) {
  if (!exactCurrentCorrection(context, correction, originalId)) return false;
  const current = context.memoryContext.taskRelevantMemories.filter(item => item.id === canonical.id);
  return current.length === 1 && current[0].confidence === canonical.confidence && current[0].status === canonical.status
    && current[0].reasons?.includes("warning:owner_statement_control_feedback_not_verified_fact")
    && current[0].reasons.includes("relevant_recent_revision") && current[0].reasons.includes("reserved_relevant_revision");
}

export function completedRealTask(round) {
  const state = round?.after?.state, durable = state?.stateJson, runId = round?.result?.loopRunId;
  const trace = round?.result?.result?.result?.executionTrace;
  const terminal = trace?.events?.filter(event => ["completed", "error", "budget_exceeded"].includes(event.type)) ?? [];
  const completed = round?.events?.filter(event => event.type === "loop_run_completed" && event.loopRunId === runId) ?? [];
  const observed = round?.events?.filter(event => event.type === "agent_runtime_terminal" && event.metadata?.receiptAuthority === "runtime") ?? [];
  const receipt = observed.length === 1 ? observed[0] : null, runtime = receipt?.metadata?.runtimeTerminal;
  const traced = trace?.events?.filter(event => event.type === "agent_runtime_terminal") ?? [];
  return round?.failure === null && round.result?.result?.status === "success" && !round.result.result.error
    && typeof runId === "string" && typeof round.result.result.output === "string" && round.result.result.output.trim().length > 0
    && durable?.lastLoopRunId === runId && durable.lastJobStatus === "success" && durable.lastVerificationPassed === true
    && durable.lastCheckerPassed === true && durable.lastOutcomeAction === "complete" && durable.lastAttemptsUsed === 1
    && state.currentPhase === "idle" && state.blockedReason === null && completed.length === 1 && completed[0].body === round.result.result.output
    && trace?.budgetExceeded === false && trace.maxToolCalls === 12 && Number.isSafeInteger(trace.toolCallCount) && trace.toolCallCount <= 12
    && terminal.length > 0 && terminal.at(-1).type === "completed" && terminal.at(-1).status === "completed"
    && !terminal.some(event => event.type !== "completed")
    && receipt?.metadata.ordinal === 1 && receipt.metadata.currentRunId === runId && receipt.loopRunId === runId
    && receipt.workshopId === round.before?.workshopId && receipt.loopId === round.before?.loopId
    && same(receipt.metadata.scope, { kind: "loop", loopId: round.before.loopId })
    && receipt.metadata.runtime?.engine === "pi" && receipt.metadata.runtime.adapter === "pi-agent-harness" && typeof receipt.metadata.runtime.version === "string"
    && runtime?.schemaVersion === "agent-runtime-terminal.v1" && runtime.status === "completed" && runtime.cleanupStatus === "completed"
    && runtime.completionScope === "runtime" && !runtime.error && (runtime.runtimeStatus === undefined || runtime.runtimeStatus === "completed")
    && trace.runtimeTerminalCount === 1 && same(trace.runtimeTerminal, runtime)
    && traced.length === 1 && traced[0].status === "completed" && same(traced[0].metadata?.runtimeTerminal, runtime)
    && Number.isSafeInteger(receipt.seq) && Number.isSafeInteger(completed[0].seq) && receipt.seq < completed[0].seq
    && Number.isFinite(Date.parse(receipt.createdAt)) && Date.parse(receipt.createdAt) <= Date.parse(completed[0].createdAt);
}

/** Bind the whole parent receipt, never just a run ID mentioned in a chain. */
export function exactResumeParent(checkpoint, previous, first) {
  const latest = previous.events.filter(event => ["working_memory_updated", "working_memory_restored", "working_memory_continuity_loaded"].includes(event.type)
    && event.metadata?.receiptAuthority === "runtime").sort((a, b) => a.seq - b.seq).at(-1);
  if (latest?.type === "working_memory_updated") return exactFreshRetryCheckpoint(checkpoint, previous);
  if (latest?.type !== "working_memory_continuity_loaded" || latest.metadata.status !== "inherited"
    || latest.metadata.currentRunId !== previous.result.loopRunId || !exactFreshRetryCheckpoint(latest.metadata.checkpoint, first)) return false;
  const expected = structuredClone(latest.metadata.checkpoint);
  expected.chain.depth += 1;
  expected.chain.viaRunIds.push(previous.result.loopRunId);
  return same(checkpoint, expected);
}

export function freshSourceCheckpoint(round) {
  const events = round?.events ?? [], last = events.filter(event => ["working_memory_updated", "working_memory_restored"].includes(event.type)
    && event.metadata?.receiptAuthority === "runtime").sort((a, b) => a.seq - b.seq).at(-1);
  if (last?.type !== "working_memory_updated" || last.metadata.mode !== "apply" || last.metadata.status !== "ready_for_projection"
    || !last.metadata.state?.openQuestions?.length) return false;
  return (last.metadata.state.facts ?? []).some(note => Array.isArray(note.evidenceIds) && note.evidenceIds.length > 0 && note.evidenceIds.every(toolCallId => {
    const matches = last.metadata.evidenceCatalog?.filter(item => item.toolCallId === toolCallId) ?? [], entry = matches[0], binding = entry?.sourceIdentity;
    const source = events.find(event => event.id === (binding?.sourceEventId ?? binding?.evidenceEventId)), raw = source?.metadata;
    const prepared = events.find(event => event.type === "working_memory_projected" && event.metadata?.receiptAuthority === "runtime"
      && event.metadata.status === "provider_request_prepared" && event.metadata.version === last.metadata.version && event.seq > last.seq
      && same(event.metadata.policyIdentity, last.metadata.policyIdentity) && event.metadata.evidenceCatalog?.some(item => item.toolCallId === toolCallId
        && item.referenceEligible === true && item.sourceIdentityStatus === "reported" && item.contentHash === entry.contentHash && same(item.sourceIdentity, binding)));
    return matches.length === 1 && entry.toolName === "webReadPage" && entry.referenceEligible === true && entry.sourceIdentityStatus === "reported"
      && /^[a-f0-9]{64}$/.test(entry.contentHash) && /^[a-f0-9]{64}$/.test(binding?.contentHash)
      && source?.type === "source_checked" && raw?.receiptAuthority === "runtime" && raw.ok === true && raw.toolName === "webReadPage"
      && source.workshopId === round.before.workshopId && source.loopId === round.before.loopId && source.loopRunId === round.result.loopRunId
      && source.seq < last.seq && (raw.toolUseId ?? raw.toolCallId) === toolCallId && raw.contentHash === binding.contentHash && raw.evidenceId === binding.evidenceId
      && ["offset", "contentLength", "totalChars", "sourceVersion"].every(key => binding[key] === raw[key])
      && Number.isSafeInteger(binding.offset) && binding.offset >= 0 && Number.isSafeInteger(binding.contentLength) && binding.contentLength > 0
      && Number.isSafeInteger(binding.totalChars) && binding.offset + binding.contentLength <= binding.totalChars
      && !!prepared && round.providerRequests.some(request => request.kind === "working-memory-agent" && request.hostPrepared?.eventId === prepared.id
        && request.hostPrepared.seq === prepared.seq && request.hostPrepared.version === last.metadata.version && request.responseStatus === 200 && request.error === null);
  }));
}

function toolObjects(value, depth = 0) {
  if (depth > 4 || value === null || value === undefined) return [];
  if (typeof value === "string") { try { return toolObjects(JSON.parse(value), depth + 1); } catch { return []; } }
  if (Array.isArray(value)) return value.flatMap(item => toolObjects(item, depth + 1));
  return typeof value === "object" ? [value, ...toolObjects(value.text, depth + 1), ...toolObjects(value.content, depth + 1), ...toolObjects(value.data, depth + 1)] : [];
}

export function verifyResumeCampaign({ load, bytes, loadPrior, priorBytes, diskHash }) {
  const plan = load("resume-session.json"), original = loadPrior("session.json"), retry = loadPrior("retry-session.json");
  const failed = loadPrior("round-E2.json"), repair = loadPrior("repair-session.json"), correction = loadPrior("correction.json");
  const promotion = loadPrior("promotion.json"), initialReview = loadPrior("review-initial.json");
  const current = optional(loadPrior, "review-corrected.json")?.after ?? correction.afterNew;
  const corrected = { ...correction, expectedVersion: current.expectedVersion }, originalId = promotion.result.candidateId;
  const oldRounds = ["A", "B", "C", "D", "E", "E2"].map(name => loadPrior(`round-${name}.json`));
  const checks = [], dependencyWarnings = [], requestFailures = [], evidenceProof = [], usage = [], dispatch = [], seals = [], artifactHashes = {}, roundAcceptance = {};
  const check = (name, passed, detail = null) => checks.push({ name, passed: passed === true, detail });
  const rounds = roundsPlanned.map(name => optional(load, `round-${name}.json`)), missing = roundsPlanned.filter((_, index) => !rounds[index]);
  check("new phase has explicit October 18 authorization without relabeling old failures", plan.schemaVersion === "memory-continuity-resume-session.v1"
    && plan.authorization?.date === "2026-10-18" && plan.authorization.supersedesExhaustedCapOnlyForNewPhase === true && plan.authorization.preservesPriorFailures === true
    && plan.claims?.priorFailedRunsSucceeded === false && plan.claims.allHistoricalRunsSameFrozenSources === false);
  check("old exhausted retry cap remains intact and new phase is exactly three bounded rounds", same(plan.priorCampaign.oldRetryCap, retry.boundedRetry)
    && same(plan.rounds, roundsPlanned) && plan.budget.maximumRounds === 3 && plan.budget.perRunDomainMaxAttempts === 1
    && plan.budget.automaticRetry === false && plan.budget.stopAfterFailure === true && plan.budget.maxToolCalls === 12
    && Number.isSafeInteger(plan.budget.maxRequests) && plan.budget.maxRequests > 0 && plan.budget.maxRequests <= 10
    && Number.isSafeInteger(plan.budget.maxSeconds) && plan.budget.maxSeconds >= 30 && plan.budget.maxSeconds <= 360);
  check("same owner Work Loop task model permissions and manual activation", sameIdentity(plan.initial, original.initial) && sameIdentity(plan.initial, retry.initial)
    && plan.initial.workshopStatus === "active" && plan.initial.loopStatus === "active" && plan.initial.trigger?.type === "manual"
    && plan.networkMode === retry.networkMode && plan.networkPreferredAddress === retry.networkPreferredAddress);
  const priorMain = failed.providerRequests.filter(request => request.kind === "working-memory-agent"), oldBootstrap = loadPrior("bootstrap.json");
  check("actual winning model protocol and endpoint retain the preserved E2 identity", priorMain.length > 0
    && plan.provider?.credentialValuesOrHashesRecorded === false && plan.provider.resolution?.credentialsRecorded === false
    && plan.provider.resolution.model === plan.provider.actualModel && plan.provider.protocol === oldBootstrap.provider.protocol
    && plan.provider.resolution.protocol === plan.provider.protocol && plan.provider.resolution.endpointHash === oldBootstrap.provider.endpointHash
    && priorMain.every(request => { const stored = loadPrior(request.requestBodyFile);
      return hash(stored.payload) === stored.payloadHash && stored.payloadHash === request.payloadHash && sameActualMainIdentity(stored.payload, request, plan.provider); }));
  const priorManifest = Object.entries(plan.priorCampaign.artifactHashes ?? {});
  check("all preserved successful failed and review artifacts keep their exact bytes", priorManifest.length > 0 && priorManifest.every(([name, digest]) => hash(priorBytes(safeName(name))) === digest));
  check("all six previous attempts and payloads are explicitly preserved", ["A", "B", "C", "D", "E", "E2"].every(name => {
    const round = loadPrior(`round-${name}.json`);
    return ["session.json", "repair-session.json", "retry-session.json", `round-${name}.json`, `round-${name}-intent.json`, ...round.providerRequests.map(item => item.requestBodyFile)]
      .every(file => plan.priorCampaign.artifactHashes[file] === hash(priorBytes(file)));
  }));
  const priorReview = loadPrior(repair.priorReview.filename), partial = loadPrior(plan.priorCampaign.priorPartialReview);
  check("original two body failures and final incomplete retry review stay failed", exactOriginalFailure(priorReview)
    && partial.schemaVersion === "memory-continuity-partial-retry-review.v1" && partial.status === "incomplete_evidence" && partial.overallPassed === false
    && plan.priorCampaign.artifactHashes[repair.priorReview.filename] === hash(priorBytes(repair.priorReview.filename)));
  check("failed E2 remains a failed stream rather than HTTP200 success", preservedFailedE2(failed) && plan.previousRunId === failed.result.loopRunId
    && plan.priorCampaign.latestRound === "E2" && plan.priorCampaign.latestRunId === failed.result.loopRunId && same(plan.initial.state, failed.after.state)
    && loadPrior("round-E.json").result.result.status === "error");
  const promotionCheck = verifyPromotion({ initial: loadPrior("round-A.json"), promotion, ownerId: original.initial.userId,
    workshopId: original.initial.workshopId, loopId: original.initial.loopId });
  check("original source-bound notebook promotion and explicit candidate review remain proven", promotionCheck.passed && verifyReview(initialReview, promotion.memory.memory), promotionCheck.errors);
  check("same exact versioned correction and original stored confidence and status", verifyCorrection(correction, initialReview.after.memory)
    && current.memory.content === correction.request.content && current.memory.content.length === 323 && current.memory.confidence === 25 && current.memory.status === "active"
    && plan.preservedConfidence === current.memory.confidence && plan.correction.memoryId === current.memory.id && plan.correction.expectedVersion === current.expectedVersion
    && plan.correction.status === current.memory.status && plan.correction.contentHash === hash(current.memory.content));
  const bPayloads = loadPrior("round-B.json").providerRequests.filter(item => item.kind === "working-memory-agent").map(item => loadPrior(item.requestBodyFile).payload);
  const bContexts = bPayloads.flatMap(inputTextParts).flatMap(text => embeddedObjects(text, "Workshop context:")).filter(context => context.workshop?.id === original.initial.workshopId);
  check("original B really received reviewed memory before correction", bContexts.length > 0 && bContexts.every(context => context.memoryRecall?.backend === "brain"
    && context.memoryRecall.contextPack?.selected?.some(item => item.id === originalId)
    && context.memoryContext?.taskRelevantMemories?.some(item => item.id === originalId && item.content === initialReview.after.memory.content && item.revisionVersion === initialReview.after.expectedVersion)));
  const frozen = resumeFrozenSources(plan.initial.sourceHashes), oldSources = resumeFrozenSources(retry.initial.sourceHashes);
  const sourceDelta = sourceDifference(oldSources, frozen), allowed = ["apps/web/scripts/prove-memory-continuity.ts", "apps/web/lib/loops/context-window.ts",
    "apps/web/lib/ai/agent-runtime-error.ts",
    "apps/web/lib/loops/native-executor.ts",
    "apps/web/lib/types/execution-result.ts",
    "packages/ai/src/agent/runtime/pi-model-config.ts", "packages/ai/src/agent/runtime/pi-harness-adapter.ts", "packages/ai/src/agent/runtime/pi-provider-terminal.ts",
    "packages/ai/src/agent/runtime/pi-stream-diagnostics.ts"];
  check("new source version is explicit and bounded to authorized fixes", same(sourceDelta, plan.sourceDelta) && same(plan.sourceChangePolicy.allowedChangedPaths, allowed)
    && sourceDelta.every(item => allowed.includes(item.path)) && sourceDelta.some(item => item.path === "apps/web/lib/loops/context-window.ts")
    && same(plan.sourceChangePolicy.newOrPreviouslyUnsealedDependencies, sourceDelta.filter(item => item.beforeHash === null).map(item => item.path)));
  check("current runtime and runner exactly match the new freeze", Object.keys(frozen).length > 0 && Object.entries(frozen).every(([path, digest]) => diskHash(path) === digest));
  artifactHashes["resume-session.json"] = hash(bytes("resume-session.json"));
  const preflightPassed = checks.every(item => item.passed);
  let allMainUsageComplete = true;
  for (let index = 0; index < rounds.length; index++) {
    const name = roundsPlanned[index], round = rounds[index], firstCheck = checks.length;
    check(`${name}: actual round exists`, !!round);
    if (!round) { roundAcceptance[name] = { attempted: false, mechanismPassed: false, mainUsageComplete: null }; continue; }
    const previous = index === 0 ? failed : rounds[index - 1];
    artifactHashes[`round-${name}.json`] = hash(bytes(`round-${name}.json`));
    check(`${name}: exact complete real task with persisted terminal checker and verification`, round.round === name && completedRealTask(round));
    check(`${name}: scope and frozen configuration unchanged`, sameIdentity(round.before, plan.initial) && sameIdentity(round.after, plan.initial)
      && round.before.workshopStatus === "active" && round.before.loopStatus === "active" && round.after.workshopStatus === "active" && round.after.loopStatus === "active");
    check(`${name}: safe effective provider readback retains model protocol endpoint`, round.providerResolution?.credentialsRecorded === false
      && round.providerResolution.model === plan.provider.actualModel && round.providerResolution.protocol === plan.provider.protocol
      && round.providerResolution.endpointHash === plan.provider.resolution.endpointHash);
    check(`${name}: follows exact latest durable state and never retries a failed new round`, !!previous && same(round.before.state, previous.after.state)
      && (index === 0 || completedRealTask(previous)) && round.after.state.stateJson.lastAttemptsUsed === 1);
    check(`${name}: new command and run cannot replay any earlier attempt`, [...oldRounds, ...rounds.slice(0, index).filter(Boolean)].every(earlier =>
      earlier.result?.loopRunId !== round.result?.loopRunId && earlier.intent?.commandId !== round.intent?.commandId)
      && round.intent.userId === plan.initial.userId && round.intent.workId === plan.initial.workshopId && round.intent.loopId === plan.initial.loopId
      && round.intent.expectedVersion === round.before.commandVersion && round.intent.mode === "native_agent" && round.intent.source === "owner");
    const intent = optional(load, `round-${name}-intent.json`);
    check(`${name}: actual immutable intent binds the new plan and snapshot`, !!intent && same(intent.intent, round.intent) && same(intent.before, round.before)
      && same(intent.campaignPlan, round.campaignPlan) && round.campaignPlan?.filename === "resume-session.json" && round.campaignPlan.hash === artifactHashes["resume-session.json"]);
    if (intent) artifactHashes[`round-${name}-intent.json`] = hash(bytes(`round-${name}-intent.json`));
    check(`${name}: no outbox or external delivery`, round.intent.createOutboxDrafts === false && round.result?.outboxDrafts?.length === 0);
    check(`${name}: explicit model time and tool budgets respected`, round.budget?.maxRequests === plan.budget.maxRequests && round.budget.maxSeconds === plan.budget.maxSeconds
      && round.budget.maxToolCalls === plan.budget.maxToolCalls && round.providerRequests.length > 0 && round.providerRequests.length <= plan.budget.maxRequests
      && Number.isFinite(round.durationMs) && round.durationMs <= plan.budget.maxSeconds * 1000 + 30000);
    for (const [stage, sources] of [["before", round.before.sourceHashes], ["after", round.after.sourceHashes], ["final", round.sourceHashes]]) {
      check(`${name} ${stage}: exact new runtime freeze`, same(resumeFrozenSources(sources), frozen));
      seals.push({ round: name, stage, recordedSources: Object.keys(sources).length, runtimeAndRunnerSources: Object.keys(resumeFrozenSources(sources)).length });
    }
    check(`${name}: own complete scoped audit`, round.events.length > 0 && round.events.every(event => event.workshopId === plan.initial.workshopId
      && event.loopId === plan.initial.loopId && event.loopRunId === round.result.loopRunId && event.metadata?.__truncated !== true));
    const payloads = [], payloadRequests = new Map();
    for (const request of round.providerRequests) {
      safeName(request.requestBodyFile);
      const captured = load(request.requestBodyFile); artifactHashes[request.requestBodyFile] = hash(bytes(request.requestBodyFile));
      check(`${name}: request ${request.index} exact captured payload`, hash(captured.payload) === captured.payloadHash && captured.payloadHash === request.payloadHash);
      const successfulTransport = request.responseStatus >= 200 && request.responseStatus < 300 && request.error === null;
      if (!successfulTransport) {
        const failure = { round: name, index: request.index, kind: request.kind, status: request.responseStatus, error: request.error };
        requestFailures.push(failure); if (request.kind !== "working-memory-agent") dependencyWarnings.push(failure);
      }
      if (request.kind === "working-memory-agent") { payloads.push(captured.payload); payloadRequests.set(captured.payload, request); check(`${name}: main request ${request.index} transport succeeded`, successfulTransport);
        check(`${name}: main request ${request.index} keeps the actual preserved model protocol endpoint`, sameActualMainIdentity(captured.payload, request, plan.provider)); }
    }
    const mapping = verifyDispatchOrder(round); dispatch.push({ round: name, ...mapping });
    check(`${name}: persisted preparation precedes actual dispatch and matching SDK result`, mapping.passed, mapping.errors);
    const contexts = payloads.map(payload => inputTextParts(payload).flatMap(text => embeddedObjects(text, "Workshop context:"))
      .filter(context => context.workshop?.id === plan.initial.workshopId));
    check(`${name}: complete current body and exact selected revision with true confidence status reserve and warning`, payloads.length > 0
      && contexts.every(group => group.length === 1 && currentCorrectionQualifiers(group[0], corrected, originalId, current.memory)));
    const stateInputs = payloads.map(payload => inputTextParts(payload).flatMap(text => embeddedObjects(text, "Current durable state:")));
    check(`${name}: actual prompt contains latest durable predecessor identity`, !!previous && payloads.length > 0
      && stateInputs.every(group => group.length === 1 && group[0].stateJson?.lastLoopRunId === previous.result.loopRunId));
    const receipts = round.events.filter(event => event.type === "working_memory_continuity_loaded" && event.metadata?.receiptAuthority === "runtime");
    const receipt = receipts.length === 1 ? receipts[0] : null, checkpoint = receipt?.metadata?.checkpoint, historyGroups = payloads.map(continuityFromPayload), actualHistory = historyGroups.flat();
    check(`${name}: continuity receipt binds the actual current scoped run`, !!receipt && receipt.metadata.currentRunId === round.result.loopRunId
      && same(receipt.metadata.scope, { kind: "loop", loopId: plan.initial.loopId }) && receipt.metadata.claimGuard?.suppressHistoricalClaims === true);
    if (index === 0) {
      check("R1: failed E2 safely skipped with no old historical prompt", receipt?.metadata.status === "skipped" && receipt.metadata.reason === "latest_run_unsuccessful"
        && checkpoint === null && actualHistory.length === 0);
      check("R1: actual fresh source-bound accepted notebook replaces pre-failure ancestry", freshSourceCheckpoint(round));
    } else {
      check(`${name}: exact canonical checkpoint reached every actual main input`, receipt?.metadata.status === "inherited" && payloads.length > 0
        && historyGroups.every(group => group.length === 1 && same(group[0], continuityAuditResult(receipt.metadata))));
      check(`${name}: exact new parent checkpoint with independent root identity`, !!previous && !!rounds[0] && exactResumeParent(checkpoint, previous, rounds[0]));
      check(`${name}: current Brain suppresses historical assertions and actions`, checkpoint?.chain?.assertionsSuppressed === true
        && checkpoint.history?.facts?.length === 0 && checkpoint.history.hypotheses?.length === 0 && checkpoint.history.nextAction === null
        && checkpoint.history.openQuestions?.length > 0 && checkpoint.sourceRefs?.length === 0);
    }
    const includes = correction.evaluationAssertions?.outputIncludes ?? [], excludes = correction.evaluationAssertions?.outputExcludes ?? [], output = round.result?.result?.output ?? "";
    check(`${name}: complete output matches original exact owner assertions`, includes.length > 0 && excludes.length > 0
      && includes.every(value => output.includes(value)) && excludes.every(value => !output.includes(value)));
    const net = round.network, preflight = net?.preflight?.filter(item => item.address === net.selectedAddress && item.transportSucceeded) ?? [];
    check(`${name}: actual endpoint is bound to the unchanged scoped TLS route`, net?.mode === plan.networkMode && net.mode === "verified-direct-opencode"
      && (net.preferredAddress ?? null) === plan.networkPreferredAddress && net.targetOrigin === "https://opencode.ai" && net.scope === "isolated-process-target-origin-only"
      && net.certificateValidation === true && net.originalHostnameAndSniPreserved === true && net.processEnvironmentChanged === false && net.globalDispatcherChanged === false
      && net.preflightModelRequests === 0 && net.publicIpv4Candidates?.includes(net.selectedAddress) && preflight.length === 1
      && round.providerRequests.filter(request => request.kind === "working-memory-agent").every(request => request.endpointHash === hash("https://opencode.ai/zen/go/v1/chat/completions")));
    for (const payload of payloads) {
      const calls = new Map((payload.messages ?? []).filter(message => message.role === "assistant").flatMap(message => message.tool_calls ?? []).map(call => [call.id, call]));
      for (const message of payload.messages ?? []) if (message.role === "tool") {
        const actualCalls = round.events.filter(event => exactEvidenceCallBinding(calls.get(message.tool_call_id), event, current.memory.id));
        const prepared = round.events.find(event => event.id === payloadRequests.get(payload)?.hostPrepared?.eventId);
        const results = round.events.filter(event => actualCalls.some(call => completedEvidenceResultOrder(call, event, prepared, message.tool_call_id)));
        if (actualCalls.length && results.length && toolObjects(message.content).some(result => verifiedEvidenceExpansion(result, corrected, originalId))
          && !evidenceProof.some(item => item.toolCallId === message.tool_call_id)) evidenceProof.push({ round: name, mode: "autonomous-model-tool-use", toolCallId: message.tool_call_id,
            runtimeCallEventIds: actualCalls.map(event => event.id), runtimeResultEventIds: results.map(event => event.id), fromSuccessfulTask: completedRealTask(round) });
      }
    }
    const toolFailures = round.events.filter(event => event.type === "tool_result" && event.metadata?.runtimeTrace === true && event.metadata.traceStatus === "error"
      && event.metadata.toolName?.split("__").at(-1) === "workshopGetMemoryEvidence");
    check(`${name}: typed memory evidence tool never returns the former resolver failure`, toolFailures.length === 0);
    const persistedUsage = round.events.filter(event => event.type === "working_memory_usage" && event.metadata?.receiptAuthority === "runtime");
    check(`${name}: convenience usage mirrors the actual scoped audit`, same(round.usageEvents, persistedUsage));
    const receiptsUsage = persistedUsage.map(event => event.metadata), main = round.providerRequests.filter(request => request.kind === "working-memory-agent");
    const usageComplete = main.length > 0 && receiptsUsage.length === main.length && receiptsUsage.every(item => item.receiptAuthority === "runtime" && item.source === "sdk_result"
      && item.usageStatus === "reported" && ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens"].every(key => Number.isSafeInteger(item[key]) && item[key] >= 0));
    allMainUsageComplete &&= usageComplete;
    usage.push({ round: name, resultStatus: round.result?.result?.status ?? "unknown", mainRequests: main.length, totalProviderRequests: round.providerRequests.length,
      sdkReceipts: receiptsUsage.length, reportedReceipts: receiptsUsage.filter(item => item.usageStatus === "reported").length,
      unknownReceipts: receiptsUsage.filter(item => item.usageStatus !== "reported").length, mainUsageComplete: usageComplete,
      reportedTokenSubtotal: receiptsUsage.filter(item => item.usageStatus === "reported" && Number.isSafeInteger(item.totalTokens)).reduce((total, item) => total + item.totalTokens, 0),
      fullTokenTotal: usageComplete ? receiptsUsage.reduce((total, item) => total + item.totalTokens, 0) : null, auxiliaryTokens: null, monetaryCostUsd: null });
    if (!completedRealTask(round)) requestFailures.push({ round: name, kind: "terminal_task_failed_or_unknown", http200IsCompletion: false, actualStatus: round.result?.result?.status ?? "unknown" });
    roundAcceptance[name] = { attempted: true, mechanismPassed: preflightPassed && checks.slice(firstCheck).every(item => item.passed), mainUsageComplete: usageComplete,
      completeRealTask: completedRealTask(round), failedChecks: checks.slice(firstCheck).filter(item => !item.passed).map(item => item.name),
      interpretation: "Per-round evidence only. Subsequent rounds require a separate explicit owner command; the three-round campaign and typed observation expansion still need their own final checks." };
  }
  const actualRounds = rounds.filter(Boolean);
  check("new runs have unique actual identities and commands", new Set(actualRounds.map(round => round.result?.loopRunId)).size === actualRounds.length
    && new Set(actualRounds.map(round => round.intent?.commandId)).size === actualRounds.length);
  check("successful new task actually expands corrected typed owner observation", evidenceProof.some(item => item.fromSuccessfulTask), evidenceProof);
  const mechanismPassed = checks.every(item => item.passed), mainUsageComplete = allMainUsageComplete && missing.length === 0;
  const passed = mechanismPassed && mainUsageComplete;
  return { schemaVersion: "memory-continuity-resume-independent-review.v1", reviewedAt: new Date().toISOString(),
    status: missing.length ? "incomplete_evidence" : !mechanismPassed ? "failed" : !mainUsageComplete ? "mechanism_verified_main_usage_inconclusive"
      : dependencyWarnings.length ? "mechanism_verified_dependencies_degraded" : "mechanism_verified_auxiliary_usage_unknown",
    passed, mechanismPassed, taskStabilityVerified: mechanismPassed, preflightPassed, roundAcceptance, mainUsageComplete, auxiliaryUsageComplete: false,
    measurementStatus: mainUsageComplete ? "main_sdk_usage_complete_auxiliary_cost_unknown" : "main_sdk_usage_inconclusive",
    checks, missingEvidence: missing, sourceDelta, seals, dispatch, usage,
    dependencyWarnings, requestFailures, evidenceProof, priorCampaign: plan.priorCampaign.directory, priorAttempts: 6,
    attemptedNewRounds: actualRounds.length, consecutiveSuccessfulNewTasks: (() => { let count = 0; for (const round of rounds) { if (!round || !completedRealTask(round)) break; count++; } return count; })(),
    modelRequestTotals: { newProviderRequests: usage.reduce((total, item) => total + item.totalProviderRequests, 0), newMainRequests: usage.reduce((total, item) => total + item.mainRequests, 0),
      reportedTokenSubtotal: usage.reduce((total, item) => total + item.reportedTokenSubtotal, 0), fullMainTokens: mainUsageComplete ? usage.reduce((total, item) => total + item.fullTokenTotal, 0) : null,
      auxiliaryTokens: null, monetaryCostUsd: null },
    claims: { threeConsecutiveBoundedMechanismTasksVerified: mechanismPassed, priorFailedRunsSucceeded: false, allHistoricalRunsSameFrozenSources: false,
      naturalTaskQualityImproved: false, causalMemoryBenefitProved: false, costReduced: false, productionDeployed: false },
    evidenceBoundary: ["A separate October 18 authorization and source freeze continues the same Work and Loop; original failed A-D review and E/E2 failures remain immutable.",
      "Exact current memory delivery, owner feedback warning, version lineage and task completion are mechanism evidence; three bounded fixture tasks do not prove universal stability or natural-task improvement.",
      "A typed owner observation proves the owner's correction submission, never independently verifies its business facts.",
      "HTTP response status is transport evidence only. Main SDK tokens are distinct from auxiliary usage; unknown usage and monetary costs remain null.",
      "Network metadata binds the scoped dispatcher and actual endpoint hash, without socket-peer observation or packet capture."], artifactHashes };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../.."), argument = process.argv.find(value => value.startsWith("--dir="))?.slice(6);
  if (!argument) throw Error("Explicit --dir required");
  const directory = resolve(argument), scoped = value => relative(repository, value).startsWith(`.tmp${sep}memory-continuity${sep}`);
  if (!scoped(directory)) throw Error("Resume ledger must remain within repository acceptance scope");
  const bytes = name => readFileSync(resolve(directory, safeName(name)), "utf8"), load = name => JSON.parse(bytes(name));
  const plan = load("resume-session.json"), priorDirectory = resolve(repository, plan.priorCampaign.directory);
  if (!scoped(priorDirectory) || priorDirectory === directory) throw Error("Distinct preserved prior acceptance scope required");
  const priorBytes = name => readFileSync(resolve(priorDirectory, safeName(name)), "utf8"), loadPrior = name => JSON.parse(priorBytes(name));
  let result;
  try { result = verifyResumeCampaign({ load, bytes, loadPrior, priorBytes,
    diskHash: path => existsSync(resolve(repository, path)) ? hash(readFileSync(resolve(repository, path), "utf8")) : null }); }
  catch (error) { result = { schemaVersion: "memory-continuity-resume-independent-review.v1", reviewedAt: new Date().toISOString(), status: "incomplete_evidence",
    passed: false, mechanismPassed: false, taskStabilityVerified: false, mainUsageComplete: null, consecutiveSuccessfulNewTasks: 0,
    checks: [{ name: "required saved evidence is available and structurally readable", passed: false, detail: { code: error?.code ?? error?.name ?? "unknown_error" } }],
    evidenceBoundary: ["Missing or malformed historical evidence cannot establish acceptance; no previous artifact was rewritten."] }; }
  const filename = `resume-independent-review-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(resolve(directory, filename), JSON.stringify(result, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
  console.log(JSON.stringify({ status: result.status, passed: result.passed, mechanismPassed: result.mechanismPassed, completed: result.consecutiveSuccessfulNewTasks,
    preflightPassed: result.preflightPassed ?? false, roundAcceptance: result.roundAcceptance ?? {},
    failedChecks: result.checks.filter(item => !item.passed).map(item => item.name), artifact: relative(repository, resolve(directory, filename)) }));
  if (!result.passed) process.exitCode = 1;
}
