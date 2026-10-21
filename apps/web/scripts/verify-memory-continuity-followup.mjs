/** File-only follow-up audit. No model, database or domain calls. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalHash, same, inputTextParts, embeddedObjects, continuityFromPayload, continuityAuditResult,
  verifyDispatchOrder, verifyPromotion, verifyReview, verifyCorrection } from "./lib/memory-continuity-verification.mjs";

const hash = value => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const originalFailures = ["C: exact corrected body and current version supplied", "D: exact corrected body and current version supplied"];
export const frozenSources = hashes => Object.fromEntries(Object.entries(hashes ?? {}).filter(([path]) =>
  !path.endsWith("scripts/verify-memory-continuity.mjs") && !path.endsWith("scripts/verify-memory-continuity-followup.mjs")
  && !path.includes("scripts/lib/memory-continuity-verification")));

export function exactCurrentCorrection(context, correction, originalId) {
  const id = correction.result?.newMemory?.id, selected = context?.memoryRecall?.contextPack?.selected ?? [];
  const memories = context?.memoryContext?.taskRelevantMemories ?? [];
  const selectedCurrent = selected.filter(item => item.id === id);
  return context?.memoryRecall?.backend === "brain" && typeof id === "string" && selectedCurrent.length === 1
    && selectedCurrent[0].revisionVersion === correction.expectedVersion
    && !selected.some(item => item.id === originalId) && !memories.some(item => item.id === originalId)
    && memories.some(item => item.id === id && item.content === correction.request?.content
      && item.revisionVersion === correction.expectedVersion);
}

export function exactFreshRetryCheckpoint(checkpoint, previous) {
  const latest = previous.events.filter(event => ["working_memory_updated", "working_memory_restored", "working_memory_continuity_loaded"].includes(event.type)
    && event.metadata?.receiptAuthority === "runtime").sort((a, b) => a.seq - b.seq).at(-1);
  if (!checkpoint || latest?.type !== "working_memory_updated" || latest.metadata.mode !== "apply" || latest.metadata.status !== "ready_for_projection") return false;
  const created = Date.parse(latest.createdAt), expires = Date.parse(checkpoint.expiresAt);
  return checkpoint.sourceRunId === previous.result.loopRunId && checkpoint.checkpointEventId === latest.id
    && checkpoint.version === latest.metadata.version && same(checkpoint.policyIdentity, latest.metadata.policyIdentity)
    && checkpoint.createdAt === new Date(created).toISOString() && Number.isFinite(expires) && expires > created && expires <= created + 7 * 86400000
    && checkpoint.chain?.depth === 0 && same(checkpoint.chain.viaRunIds, []) && checkpoint.chain.assertionsSuppressed === true
    && same(checkpoint.history?.openQuestions, [...new Set(latest.metadata.state?.openQuestions ?? [])])
    && checkpoint.chain.rootHash === canonicalHash({ workshopId: previous.before.workshopId, sourceRunId: previous.result.loopRunId,
      checkpointEventId: latest.id, metadata: latest.metadata, expiresAt: checkpoint.expiresAt });
}

export function exactOriginalFailure(review) {
  return review?.schemaVersion === "memory-continuity-independent-review.v1" && review.status === "failed"
    && review.mechanismPassed === false && review.modelUsePassed === true
    && same((review.checks ?? []).filter(item => item.passed !== true).map(item => item.name).sort(), [...originalFailures].sort());
}

export function eligibleExternalFailure(round) {
  return round?.round === "E" && !round.failure && round.result?.result?.status === "error"
    && typeof round.result.result.error === "string" && /\[data_inspection_failed\]/.test(round.result.result.error)
    && round.providerRequests?.length > 0 && round.providerRequests.every(request => request.responseStatus === 200 && request.error === null)
    && round.events?.some(event => event.type === "tool_error" && typeof event.body === "string" && event.body.includes("data_inspection_failed"))
    && round.after?.state?.stateJson?.lastLoopRunId === round.result.loopRunId && round.after.state.stateJson.lastJobStatus === "error"
    && round.after.state.stateJson.lastOutcomeAction === "fail" && round.after.state.stateJson.lastAttemptsUsed === 1;
}

const retryRequiredRuntime = ["apps/web/lib/memory/retrieval/candidates.ts", "apps/web/lib/memory/retrieval/recall.ts", "apps/web/lib/memory/context/pack.ts",
  "apps/web/lib/memory/context/workshop-memory.ts", "apps/web/lib/workshops/memory-context.ts", "apps/web/lib/loops/context-window.ts"];
export const retryAllowedPaths = ["apps/web/scripts/prove-memory-continuity.ts", ...retryRequiredRuntime, "apps/web/lib/loops/memory-recall-risk.ts"];
export function boundedRetrySourceDelta(delta) {
  return delta.length > 0 && delta.every(item => retryAllowedPaths.includes(item.path))
    && retryRequiredRuntime.every(path => delta.some(item => item.path === path && typeof item.afterHash === "string"))
    && delta.every(item => item.path !== "apps/web/lib/loops/memory-recall-risk.ts" || item.beforeHash === null);
}

export function verifiedEvidenceExpansion(result, correction, originalId) {
  const observationId = correction.afterNew?.memory?.metadata?.revision?.observationId;
  const reference = typeof observationId === "string" ? `brain-observation:${observationId}` : null;
  const observation = result?.brainEvidence?.find(item => item.id === reference && item.status === "resolved" && item.source === "brain_observation");
  let submission = null;
  try { submission = JSON.parse(observation?.content); } catch { /* Missing/malformed evidence cannot prove the repair. */ }
  return !!reference && result?.status === "read" && result.provider === "workshop_memory_evidence" && result.memoryBackend === "brain"
    && result.memory?.id === correction.result?.newMemory?.id && result.memory.content === correction.request.content
    && result.memory.expectedVersion === correction.expectedVersion && result.memory.revisionVersion === correction.expectedVersion
    && observation?.metadata?.sourceType === "owner_memory_revision" && observation.metadata.sourceId === correction.request.commandId
    && observation.metadata.contentHash === hash(observation.content) && submission?.memoryId === originalId && same(submission.request, correction.request)
    && observation.metadata.provenance?.provesOwnerSubmissionOnly === true && observation.metadata.provenance?.independentlyVerifiesBusinessFact === false
    && result.evidenceResolution?.some(item => item.id === reference && item.status === "resolved" && item.provider === "brain_observation");
}

export function exactEvidenceCallBinding(call, event, memoryId) {
  let requested = call?.function?.arguments ?? call?.arguments, recorded = event?.body;
  try { if (typeof requested === "string") requested = JSON.parse(requested); if (typeof recorded === "string") recorded = JSON.parse(recorded); }
  catch { return false; }
  return typeof call?.id === "string" && (call.function?.name ?? call.name)?.split("__").at(-1) === "workshopGetMemoryEvidence"
    && requested?.memoryId === memoryId && event?.type === "tool_call" && event.metadata?.runtimeTrace === true
    && event.metadata.toolUseId === call.id && event.metadata.toolName?.split("__").at(-1) === "workshopGetMemoryEvidence" && recorded?.memoryId === memoryId;
}

function toolObjects(content, depth = 0) {
  if (depth > 4 || content === null || content === undefined) return [];
  if (typeof content === "string") { try { return toolObjects(JSON.parse(content), depth + 1); } catch { return []; } }
  if (Array.isArray(content)) return content.flatMap(item => toolObjects(item, depth + 1));
  if (typeof content !== "object") return [];
  return [content, ...toolObjects(content.text, depth + 1), ...toolObjects(content.content, depth + 1), ...toolObjects(content.data, depth + 1)];
}

function safeName(name) {
  if (typeof name !== "string" || !/^[A-Za-z0-9_.-]+\.json$/.test(name) || name.includes("..")) throw Error("Invalid acceptance artifact filename");
  return name;
}

export function verifyFollowupCampaign({ load, bytes, diskHash }) {
  const session = load("session.json"), repair = load("repair-session.json"), retry = existsOptional(load, "retry-session.json");
  const finalPlan = retry ?? repair, freshNames = retry ? ["E2", "F"] : ["E", "F"];
  const names = retry ? ["A", "B", "C", "D", "E", "E2", "F"] : ["A", "B", "C", "D", "E", "F"];
  const rounds = names.map(name => load(`round-${name}.json`)), checks = [], dependencyWarnings = [], requestFailures = [], dispatchMappings = [], usage = [];
  const check = (name, passed, detail = null) => checks.push({ name, passed: passed === true, detail });
  const priorName = safeName(repair.priorReview.filename), prior = load(priorName);
  check("original failed review remains exact and is not relabeled passed", exactOriginalFailure(prior)
    && hash(bytes(priorName)) === repair.priorReview.hash && same(repair.priorReview.failedChecks, [...originalFailures].sort()));
  check("repair plan uses the same owner Work Loop fixed task configuration", ["userId", "workshopId", "loopId", "goalHash", "modelConfigHash", "loopConfigurationHash"]
    .every(key => repair.initial[key] === session.initial[key]) && repair.originalSessionHash === hash(bytes("session.json")));
  check("repair plan records original failure and source-version boundary", repair.schemaVersion === "memory-continuity-repair-session.v1"
    && repair.claims?.originalFourPassed === false && repair.claims?.allSixSameFrozenSources === false);
  const preserved = Object.entries(repair.preservedArtifacts ?? {});
  check("all original artifact hashes remain unchanged", preserved.length > 0 && preserved.every(([name, digest]) => hash(bytes(safeName(name))) === digest));
  check("preserved failure review artifact manifest is fully retained", Object.entries(prior.artifactHashes ?? {}).length > 0
    && Object.entries(prior.artifactHashes ?? {}).every(([name, digest]) => repair.preservedArtifacts[name] === digest));
  const originalSources = frozenSources(session.initial.sourceHashes), repairedSources = frozenSources(repair.initial.sourceHashes);
  const sourceDelta = [...new Set([...Object.keys(originalSources), ...Object.keys(repairedSources)])].sort()
    .filter(path => originalSources[path] !== repairedSources[path]).map(path => ({ path, beforeHash: originalSources[path] ?? null, afterHash: repairedSources[path] ?? null }));
  check("repair code differences are explicit and versioned", sourceDelta.length > 0 && same(sourceDelta, repair.sourceDelta), sourceDelta);
  const allowedChanges = ["apps/web/scripts/prove-memory-continuity.ts", "apps/web/lib/loops/context-window.ts", "apps/web/lib/workshops/mcp-tools.ts",
    "apps/web/lib/workshops/memory-evidence-reader.ts", "apps/web/lib/memory/evidence/reader.ts"];
  check("repair source delta remains within the declared bounded fixes", sourceDelta.every(item => allowedChanges.includes(item.path)));
  check("repair seal includes both actual defect fixes", ["apps/web/lib/loops/context-window.ts", "apps/web/lib/workshops/mcp-tools.ts",
    "apps/web/lib/workshops/memory-evidence-reader.ts", "apps/web/scripts/prove-memory-continuity.ts"].every(path => typeof repairedSources[path] === "string")
    && ["apps/web/lib/loops/context-window.ts", "apps/web/lib/workshops/mcp-tools.ts", "apps/web/lib/workshops/memory-evidence-reader.ts"].every(path => sourceDelta.some(item => item.path === path)));
  const finalSources = frozenSources(finalPlan.initial.sourceHashes);
  check("current runtime and runner match the final explicit plan freeze", Object.entries(finalSources).every(([path, digest]) => diskHash(path) === digest));
  let retrySourceDelta = [];
  if (retry) {
    const failed = load("round-E.json");
    retrySourceDelta = [...new Set([...Object.keys(repairedSources), ...Object.keys(finalSources)])].sort()
      .filter(path => repairedSources[path] !== finalSources[path]).map(path => ({ path, beforeHash: repairedSources[path] ?? null, afterHash: finalSources[path] ?? null }));
    check("single retry preserves the immutable repair plan and failed E", retry.schemaVersion === "memory-continuity-retry-session.v1"
      && retry.priorRepairSessionHash === hash(bytes("repair-session.json")) && retry.priorFailedRound?.hash === hash(bytes("round-E.json"))
      && retry.priorFailedRound.failureClass === "provider_data_inspection_failed" && eligibleExternalFailure(failed));
    check("retry is bounded to one additional E2 and subsequent F", retry.boundedRetry?.maximumAdditionalAttempts === 1 && retry.boundedRetry.maximumAdditionalRounds === 2
      && retry.boundedRetry.perRunDomainMaxAttempts === 1 && retry.boundedRetry.automaticProviderRetry === false && same(retry.boundedRetry.nextRounds, ["E2", "F"]));
    check("retry changes include only the bounded additional owner-feedback semantic fix", same(retrySourceDelta, retry.sourceDelta)
      && boundedRetrySourceDelta(retrySourceDelta)
      && retry.additionalSemanticRepair?.target === "reserve_current_own_work_owner_feedback_before_planner_filters_at_normal_risk"
      && same(retry.additionalSemanticRepair.allowedChangedPaths, retryAllowedPaths)
      && typeof retry.additionalSemanticRepair.selectionReceiptPolicy === "string", retrySourceDelta);
    check("retry task provider permissions and correction remain unchanged", ["userId", "workshopId", "loopId", "goalHash", "modelConfigHash", "loopConfigurationHash"]
      .every(key => retry.initial[key] === repair.initial[key]) && same(retry.correction, repair.correction)
      && retry.networkMode === repair.networkMode && retry.networkPreferredAddress === repair.networkPreferredAddress);
    check("retry preserves all earlier evidence and failed-E payload hashes", Object.entries(retry.preservedArtifacts ?? {}).length > Object.entries(repair.preservedArtifacts).length
      && Object.entries(retry.preservedArtifacts ?? {}).every(([name, digest]) => hash(bytes(safeName(name))) === digest)
      && ["round-E.json", "round-E-intent.json", "repair-session.json", ...failed.providerRequests.map(item => item.requestBodyFile)]
        .every(name => retry.preservedArtifacts[name] === hash(bytes(name))));
    check("retry starts from exact failed-E durable state", retry.previousRunId === failed.result.loopRunId && same(retry.initial.state, failed.after.state));
  }
  const promotion = load("promotion.json"), review = load("review-initial.json"), correction = load("correction.json");
  const current = existsOptional(load, "review-corrected.json")?.after ?? correction.afterNew;
  const corrected = { ...correction, expectedVersion: current.expectedVersion }, originalId = promotion.result.candidateId;
  if (retry) check("retry explicitly retains original correction confidence", retry.preservedConfidence === current.memory.confidence);
  check("repair continues exactly the same canonical correction", repair.correction.memoryId === current.memory.id && repair.correction.expectedVersion === current.expectedVersion
    && repair.correction.contentHash === hash(current.memory.content) && current.memory.content === correction.request.content && repair.correction.status === current.memory.status);
  const promotionCheck = verifyPromotion({ initial: rounds[0], promotion, ownerId: session.initial.userId,
    workshopId: session.initial.workshopId, loopId: session.initial.loopId });
  check("original A exact save source catalog and candidate binding", promotionCheck.passed, promotionCheck.errors);
  check("original A owner review preserves candidate identity body and evidence", verifyReview(review, promotion.memory.memory));
  check("versioned correction preserves exact request and supersession lineage", verifyCorrection(correction, review.after.memory));
  if (correction.afterNew.memory.status === "candidate") check("factual correction received explicit review", verifyReview(existsOptional(load, "review-corrected.json"), correction.afterNew.memory));
  const payloads = new Map(), contexts = new Map(), sealComparisons = [];
  for (let index = 0; index < rounds.length; index++) {
    const round = rounds[index], name = names[index], failedAttempt = !!retry && name === "E";
    const expectedSources = index < 4 ? originalSources : freshNames.includes(name) ? finalSources : repairedSources;
    check(`${name}: exact round identity and honest actual terminal status`, round.round === name && !round.failure && typeof round.result?.loopRunId === "string"
      && (failedAttempt ? eligibleExternalFailure(round) : round.result?.result?.status === "success"));
    check(`${name}: same owner Work Loop and unchanged task configuration`, ["userId", "workshopId", "loopId", "goalHash", "modelConfigHash", "loopConfigurationHash"]
      .every(key => round.before?.[key] === session.initial[key] && round.after?.[key] === session.initial[key]));
    check(`${name}: no outbox or external delivery`, round.intent.createOutboxDrafts === false && round.result.outboxDrafts?.length === 0);
    check(`${name}: actual provider requests respect the explicit budget`, round.providerRequests.length > 0 && round.providerRequests.length <= round.budget.maxRequests
      && round.durationMs <= round.budget.maxSeconds * 1000 + 30000);
    for (const [stage, seals] of [["before", round.before.sourceHashes], ["after", round.after.sourceHashes], ["final", round.sourceHashes]]) {
      check(`${name} ${stage}: source freeze matches its declared version`, same(frozenSources(seals), expectedSources));
      sealComparisons.push({ round: name, stage, recordedCount: Object.keys(seals).length, runtimeAndRunnerCount: Object.keys(frozenSources(seals)).length });
    }
    if (index >= 4) {
      const planName = retry && freshNames.includes(name) ? "retry-session.json" : "repair-session.json";
      check(`${name}: immutable explicit plan receipt was actually used`, round.campaignPlan?.filename === planName && round.campaignPlan.hash === hash(bytes(planName)));
    }
    const runId = round.result.loopRunId, state = round.after.state, durable = state?.stateJson;
    check(`${name}: own scoped complete audit events`, round.events.length > 0 && round.events.every(event => event.workshopId === session.initial.workshopId
      && event.loopId === session.initial.loopId && event.loopRunId === runId && event.metadata?.__truncated !== true));
    check(`${name}: persisted verification checker outcome and terminal state are honest`, durable?.lastLoopRunId === runId
      && (failedAttempt ? durable.lastVerificationPassed === false && durable.lastCheckerPassed === false && durable.lastOutcomeAction === "fail"
        && durable.lastJobStatus === "error" && state.currentPhase === "error" && typeof state.blockedReason === "string" && state.blockedReason.includes("data_inspection_failed")
        : durable.lastVerificationPassed === true && durable.lastCheckerPassed === true && durable.lastOutcomeAction === "complete"
          && durable.lastJobStatus === "success" && state.currentPhase === "idle" && state.blockedReason === null));
    const completed = round.events.filter(event => event.type === (failedAttempt ? "loop_run_failed" : "loop_run_completed") && event.loopRunId === runId);
    check(`${name}: exact returned output equals persistent completion`, completed.length === 1 && completed[0].body === round.result.result.output);
    const bodies = [];
    for (const request of round.providerRequests) {
      const stored = load(safeName(request.requestBodyFile));
      check(`${name}: request ${request.index} exact actual input hash`, hash(stored.payload) === stored.payloadHash && stored.payloadHash === request.payloadHash);
      const success = request.responseStatus >= 200 && request.responseStatus < 300 && request.error === null;
      if (request.kind === "working-memory-agent") check(`${name}: main request ${request.index} succeeded`, success);
      else if (!success) dependencyWarnings.push({ round: name, kind: request.kind, index: request.index, status: request.responseStatus, error: request.error });
      if (!success) requestFailures.push({ round: name, ...request });
      if (request.kind === "working-memory-agent") bodies.push(stored.payload);
    }
    payloads.set(name, bodies);
    contexts.set(name, bodies.flatMap(inputTextParts).flatMap(text => embeddedObjects(text, "Workshop context:")).find(item => item.workshop?.id === session.initial.workshopId));
    const mapping = verifyDispatchOrder(round); check(`${name}: persisted preparation precedes exact dispatch and SDK result`, mapping.passed, mapping.errors);
    dispatchMappings.push({ round: name, ...mapping });
    if (failedAttempt) requestFailures.push({ round: name, kind: "provider-stream-terminal", httpPostStatus: 200, streamErrorStatus: 400,
      code: "data_inspection_failed", resultStatus: "error", neverCountedAsSuccess: true });
    const net = round.network, preflight = net?.preflight?.filter(item => item.address === net.selectedAddress && item.transportSucceeded === true) ?? [];
    const networkPlan = index < 4 ? session : freshNames.includes(name) ? finalPlan : repair;
    check(`${name}: target-only TLS route matches saved plan and actual main endpoint`, net?.mode === "verified-direct-opencode" && net.mode === networkPlan.networkMode
      && (net.preferredAddress ?? null) === (networkPlan.networkPreferredAddress ?? null) && net.targetOrigin === "https://opencode.ai"
      && net.scope === "isolated-process-target-origin-only" && net.certificateValidation === true && net.originalHostnameAndSniPreserved === true
      && net.processEnvironmentChanged === false && net.globalDispatcherChanged === false && net.preflightModelRequests === 0
      && Array.isArray(net.publicIpv4Candidates) && net.publicIpv4Candidates.includes(net.selectedAddress) && preflight.length === 1 && Number.isInteger(preflight[0].status)
      && round.providerRequests.filter(item => item.kind === "working-memory-agent").every(item => item.endpointHash === hash("https://opencode.ai/zen/go/v1/chat/completions")));
    const receipts = round.events.filter(event => event.type === "working_memory_usage" && event.metadata?.receiptAuthority === "runtime").map(event => event.metadata);
    const main = round.providerRequests.filter(item => item.kind === "working-memory-agent");
    const complete = main.length > 0 && receipts.length === main.length && receipts.every(item => item.source === "sdk_result" && item.usageStatus === "reported"
      && ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens"].every(key => Number.isSafeInteger(item[key]) && item[key] >= 0));
    usage.push({ round: name, resultStatus: round.result.result.status, mainRequests: main.length, receipts: receipts.length, mainUsageComplete: complete,
      totalTokens: complete ? receipts.reduce((sum, item) => sum + item.totalTokens, 0) : null, priceUsd: null });
    const failures = new Map();
    for (const event of round.events) if (event.type === "tool_error") {
      const key = event.metadata?.toolUseId ?? event.id;
      failures.set(key, { round: name, kind: "tool-error", toolName: event.metadata?.toolName ?? null, toolUseId: key });
    }
    dependencyWarnings.push(...failures.values());
    if (index >= 4) check(`${name}: repaired evidence tool has no runtime failure`, ![...failures.values()].some(item => item.toolName === "workshopGetMemoryEvidence"));
  }
  check("all actual successful and failed attempts have distinct identities", new Set(rounds.map(round => round.result.loopRunId)).size === names.length);
  check("repair plan continues actual D without replacing history", repair.previousRunId === rounds[3].result.loopRunId && same(repair.initial.state, rounds[3].after.state));
  const b = contexts.get("B");
  check("original B actually received exact reviewed current memory", b?.memoryRecall?.backend === "brain"
    && b.memoryRecall.contextPack?.selected?.some(item => item.id === originalId)
    && b.memoryContext?.taskRelevantMemories?.some(item => item.id === originalId && item.content === review.after.memory.content && item.revisionVersion === review.after.expectedVersion));
  for (let index = 1; index < rounds.length; index++) {
    const round = rounds[index], previous = rounds[index - 1], inherited = round.events.find(event => event.type === "working_memory_continuity_loaded"
      && event.metadata?.receiptAuthority === "runtime" && event.metadata.status === "inherited"), checkpoint = inherited?.metadata?.checkpoint;
    const actual = payloads.get(round.round).flatMap(continuityFromPayload);
    if (retry && round.round === "E2") {
      const skipped = round.events.find(event => event.type === "working_memory_continuity_loaded" && event.metadata?.receiptAuthority === "runtime"
        && event.metadata.status === "skipped" && event.metadata.reason === "latest_run_unsuccessful");
      check("E2: failed latest E forces an explicit history skip without resurrecting D", !!skipped && !inherited
        && actual.every(item => item.status === "skipped" && !item.checkpoint));
    } else {
      check(`${round.round}: inherited exact scoped previous-run chain`, !!checkpoint && checkpoint.loopId === session.initial.loopId
        && checkpoint.authority === "historical-model-authored-unverified"
        && (checkpoint.sourceRunId === previous.result.loopRunId || checkpoint.chain?.viaRunIds?.includes(previous.result.loopRunId)));
      check(`${round.round}: canonical audited checkpoint reached actual input`, !!inherited && actual.length > 0 && actual.every(item => same(item, continuityAuditResult(inherited.metadata))));
      if (retry && round.round === "F") check("F: exact fresh E2 checkpoint replaces all pre-failure ancestry", exactFreshRetryCheckpoint(checkpoint, previous));
    }
    check(`${round.round}: durable state persisted exactly between runs`, same(previous.after.state, round.before.state));
    const states = payloads.get(round.round).flatMap(inputTextParts).flatMap(text => embeddedObjects(text, "Current durable state:"));
    check(`${round.round}: real input contains exact prior durable run identity`, states.length > 0 && states.every(item => item.stateJson?.lastLoopRunId === previous.result.loopRunId));
    if (index >= 2 && !(retry && round.round === "E2")) check(`${round.round}: current correction suppresses historical assertions`, checkpoint?.chain?.assertionsSuppressed === true
      && checkpoint.history?.facts?.length === 0 && checkpoint.history?.hypotheses?.length === 0 && checkpoint.history?.nextAction === null);
  }
  const originalBodyFailures = Object.fromEntries(["C", "D"].map(name => [name, { exactCurrentBodyDelivered: exactCurrentCorrection(contexts.get(name), corrected, originalId) }]));
  check("original C/D full-body defects remain reproduced in preserved evidence", Object.values(originalBodyFailures).every(item => item.exactCurrentBodyDelivered === false));
  for (const name of freshNames) {
    check(`${name}: exact full corrected body ID and revision reached current input`, exactCurrentCorrection(contexts.get(name), corrected, originalId));
    if (retry) check(`${name}: current owner feedback keeps its original confidence`, contexts.get(name)?.memoryContext?.taskRelevantMemories
      ?.some(item => item.id === current.memory.id && item.confidence === current.memory.confidence));
    if (retry) check(`${name}: current owner feedback keeps its actual persisted status`, contexts.get(name)?.memoryContext?.taskRelevantMemories
      ?.some(item => item.id === current.memory.id && item.status === current.memory.status));
    if (retry) check(`${name}: actual current feedback remains explicitly unverified as external fact`, contexts.get(name)?.memoryContext?.taskRelevantMemories
      ?.some(item => item.id === current.memory.id && item.reasons?.includes("warning:owner_statement_control_feedback_not_verified_fact")));
    const round = rounds.find(item => item.round === name), output = round.result.result.output;
    const required = correction.evaluationAssertions?.outputIncludes ?? [], forbidden = correction.evaluationAssertions?.outputExcludes ?? [];
    check(`${name}: actual output uses new correction and excludes obsolete literal`, required.length > 0 && forbidden.length > 0
      && required.every(text => output.includes(text)) && forbidden.every(text => !output.includes(text)));
  }
  const evidenceRepairProof = [];
  for (const name of retry ? ["E", ...freshNames] : freshNames) for (const payload of payloads.get(name)) {
    const calls = new Map((payload.messages ?? []).filter(message => message.role === "assistant").flatMap(message => message.tool_calls ?? [])
      .map(call => [call.id, call]));
    for (const message of payload.messages ?? []) if (message.role === "tool") {
      const roundEvents = rounds.find(round => round.round === name).events;
      const runtimeCalls = roundEvents.filter(event => exactEvidenceCallBinding(calls.get(message.tool_call_id), event, corrected.result.newMemory.id));
      const runtimeEvents = roundEvents.filter(event => event.type === "tool_result"
        && event.metadata?.runtimeTrace === true && event.metadata?.toolUseId === message.tool_call_id
        && event.metadata?.toolName?.split("__").at(-1) === "workshopGetMemoryEvidence" && event.metadata?.traceStatus !== "error");
      if (runtimeCalls.length > 0 && runtimeEvents.length > 0 && toolObjects(message.content).some(result => verifiedEvidenceExpansion(result, corrected, originalId))) {
        if (!evidenceRepairProof.some(item => item.toolCallId === message.tool_call_id)) evidenceRepairProof.push({ round: name,
          mode: "autonomous-model-tool-use", toolCallId: message.tool_call_id, runtimeCallEventIds: runtimeCalls.map(event => event.id), runtimeEventIds: runtimeEvents.map(event => event.id) });
      }
    }
  }
  const probe = existsOptional(load, "repair-evidence-probe.json");
  if (probe) {
    const valid = probe.schemaVersion === "memory-continuity-repair-evidence-probe.v1" && probe.mode === "host-driven-read-only"
      && ["userId", "workshopId", "loopId", "modelConfigHash"].every(key => probe[key] === finalPlan.initial[key])
      && probe.toolName === "workshopGetMemoryEvidence" && probe.input?.memoryId === corrected.result.newMemory.id
      && same(frozenSources(probe.beforeSourceHashes), finalSources) && same(frozenSources(probe.afterSourceHashes), finalSources)
      && verifiedEvidenceExpansion(probe.output, corrected, originalId);
    check("explicit host-driven evidence probe is correctly bound and read-only", valid);
    if (valid) evidenceRepairProof.push({ mode: "host-driven-read-only", artifact: "repair-evidence-probe.json", countedAsAutonomousModelUse: false });
  }
  for (const proof of evidenceRepairProof) proof.countedAsSuccessfulRoundProof = proof.mode === "host-driven-read-only" || freshNames.includes(proof.round);
  check("actual corrected owner-observation expansion proves the evidence repair", evidenceRepairProof.some(item => item.countedAsSuccessfulRoundProof),
    { proof: evidenceRepairProof, fallback: "A separately labeled host-driven read-only probe may prove resolver operation; it never counts as autonomous model use." });
  const mainUsageComplete = usage.every(item => item.mainUsageComplete), mechanismPassed = checks.every(item => item.passed);
  const postRepairTwoSameFrozenSources = rounds.filter(round => freshNames.includes(round.round)).every(round => [round.before.sourceHashes, round.after.sourceHashes, round.sourceHashes]
    .every(seals => same(frozenSources(seals), finalSources)));
  const allSixSameFrozenSources = rounds.every(round => [round.before.sourceHashes, round.after.sourceHashes, round.sourceHashes]
    .every(seals => same(frozenSources(seals), frozenSources(rounds[0].before.sourceHashes))));
  const status = !mechanismPassed ? "failed" : !mainUsageComplete ? "inconclusive_main_usage"
    : dependencyWarnings.length ? "repair_mechanism_verified_dependencies_degraded" : "repair_mechanism_verified_auxiliary_usage_unknown";
  return { schemaVersion: "memory-continuity-followup-independent-review.v1", reviewedAt: new Date().toISOString(), status,
    passed: false, mechanismPassed, mainUsageComplete,
    successfulMainUsageComplete: usage.filter(item => item.resultStatus === "success").every(item => item.mainUsageComplete),
    auxiliaryUsageComplete: false, checks, sourceDelta, retrySourceDelta, sealComparisons,
    priorFailedReview: { filename: priorName, hash: hash(bytes(priorName)), status: prior.status }, originalBodyFailures, evidenceRepairProof,
    usage, dependencyWarnings, requestFailures, dispatchMappings, promotionCheck,
    retry: retry ? { priorFailedRound: retry.priorFailedRound, explicitPlanHash: hash(bytes("retry-session.json")), boundedRetry: retry.boundedRetry,
      originalEPassed: false, successfulFollowupNames: freshNames, allAttemptCount: names.length } : null,
    failedAttemptFindings: retry ? { round: "E", resultStatus: rounds.find(round => round.round === "E").result.result.status,
      exactAutomaticCurrentContext: exactCurrentCorrection(contexts.get("E"), corrected, originalId),
      obsoleteOutputLiteralsPresent: (correction.evaluationAssertions?.outputExcludes ?? []).filter(text => rounds.find(round => round.round === "E").result.result.output.includes(text)),
      completeCurrentBodyAndOwnerObservationToolProof: evidenceRepairProof.filter(proof => proof.round === "E"),
      interpretation: "Partial positive tool receipts do not turn this failed run, absent automatic recall or obsolete partial output into a successful acceptance round." } : null,
    claims: { originalFourPassed: false, allSixSameFrozenSources, allAttemptSourcesFrozenTogether: allSixSameFrozenSources, postRepairTwoSameFrozenSources,
      naturalTaskQualityImproved: false, causalMemoryBenefitProved: false, costReduced: false, productionDeployed: false },
    evidenceBoundary: [retry ? "Original A-D failure and failed E remain immutable. Only E2/F use the additional owner-feedback reservation repair and explicit retry freeze; provider, confidence, task and permissions are unchanged."
      : "Original A-D and its failed review remain immutable. Only E/F use the repaired frozen source version.",
      "Main SDK usage is separate from auxiliary requests; auxiliary tokens and monetary costs remain unknown, never zero.",
      "Explicit mechanism fixture: prompt delivery and output agreement do not prove natural-task improvement or isolate memory causality.",
      "Network metadata binds the frozen target-origin dispatcher to actual endpoint hashes; no packet capture or socket peer observation was taken."],
    artifactHashes: Object.fromEntries([...new Set(["session.json", "repair-session.json", priorName, "promotion.json", "review-initial.json", "correction.json",
      ...(retry ? ["retry-session.json"] : []),
      ...(probe ? ["repair-evidence-probe.json"] : []), ...names.map(name => `round-${name}.json`), ...rounds.flatMap(round => round.providerRequests.map(item => item.requestBodyFile))])].map(name => [name, hash(bytes(name))])) };
}

function existsOptional(load, name) { try { return load(name); } catch (error) { if (error?.code === "ENOENT") return null; throw error; } }

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../.."), input = process.argv.find(value => value.startsWith("--dir="))?.slice(6);
  if (!input) throw Error("Explicit --dir=<preserved acceptance directory> required");
  const directory = resolve(input);
  if (!relative(repository, directory).startsWith(`.tmp${sep}memory-continuity${sep}`)) throw Error("Acceptance directory must remain scoped inside repository .tmp/memory-continuity");
  const bytes = name => readFileSync(resolve(directory, safeName(name)), "utf8");
  const retryMode = existsSync(resolve(directory, "retry-session.json"));
  const requiredFiles = ["session.json", "repair-session.json", "promotion.json", "review-initial.json", "correction.json",
    ...(retryMode ? ["retry-session.json"] : []),
    ...["A", "B", "C", "D", "E", ...(retryMode ? ["E2"] : []), "F"].map(name => `round-${name}.json`)];
  const missingFiles = requiredFiles.filter(name => !existsSync(resolve(directory, name)));
  const result = missingFiles.length ? { schemaVersion: "memory-continuity-followup-independent-review.v1", reviewedAt: new Date().toISOString(),
    status: "incomplete_evidence", passed: false, mechanismPassed: false, mainUsageComplete: null,
    checks: missingFiles.map(name => ({ name: `Required evidence missing: ${name}`, passed: false })),
    claims: { originalFourPassed: false, failedECountedAsSuccess: false, successfulFollowupProved: false },
    evidenceBoundary: "Missing or failed follow-up runs cannot be replaced by earlier successes. No missing usage or cost is represented as zero.",
    artifactHashes: Object.fromEntries(requiredFiles.filter(name => !missingFiles.includes(name)).map(name => [name, hash(bytes(name))])) }
    : verifyFollowupCampaign({ load: name => JSON.parse(bytes(name)), bytes,
      diskHash: path => existsSync(resolve(repository, path)) ? hash(readFileSync(resolve(repository, path), "utf8")) : null });
  result.auditorSourceHash = hash(readFileSync(fileURLToPath(import.meta.url), "utf8"));
  result.noModelCalls = true; result.noDatabaseOrDomainCalls = true;
  const destination = resolve(directory, `followup-independent-review-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(destination, JSON.stringify(result, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
  console.log(JSON.stringify({ status: result.status, passed: result.passed, mechanismPassed: result.mechanismPassed,
    failedChecks: result.checks.filter(item => !item.passed), destination }));
  if (!result.passed) process.exitCode = 1;
}
