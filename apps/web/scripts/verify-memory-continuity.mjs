/** Independent receipt verifier. No model calls, database access or business writes. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalHash, same, inputTextParts, embeddedObjects, continuityFromPayload, continuityAuditResult,
  verifyDispatchOrder, verifyPromotion, verifyReview, verifyCorrection } from "./lib/memory-continuity-verification.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const input = process.argv.find(value => value.startsWith("--dir="))?.slice(6);
if (!input) throw Error("Explicit --dir=<private acceptance directory> required");
const directory = resolve(input), within = relative(repository, directory);
if (!within.startsWith(`.tmp${sep}memory-continuity${sep}`)) throw Error("Receipt directory must stay inside repository .tmp/memory-continuity");
const hash = value => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const read = name => JSON.parse(readFileSync(resolve(directory, name), "utf8"));
const session = read("session.json");
const checks = [], warnings = [], dependencyWarnings = [], requestFailures = [], dispatchMappings = [];
const check = (name, passed, detail = null) => checks.push({ name, passed: passed === true, detail });
const events = round => Array.isArray(round.events) ? round.events : [];
const owned = event => event.workshopId === session.initial.workshopId && event.loopId === session.initial.loopId;
const textParts = inputTextParts;
const rounds = ["A", "B", "C", "D"].map(round => read(`round-${round}.json`));
const payloads = new Map();
const frozenSources = hashes => Object.fromEntries(Object.entries(hashes ?? {}).filter(([path]) => !path.endsWith("scripts/verify-memory-continuity.mjs")
  && !path.includes("scripts/lib/memory-continuity-verification")));
for (const round of rounds) {
  const name = round.round;
  check(`${name}: real successful run`, !round.failure && round.result?.result?.status === "success" && !!round.result?.loopRunId);
  check(`${name}: same owner workshop Loop and fixed task`, ["userId", "workshopId", "loopId", "goalHash", "modelConfigHash", "loopConfigurationHash"]
    .every(key => round.before?.[key] === session.initial[key] && round.after?.[key] === session.initial[key]));
  check(`${name}: external notification not created`, round.intent.createOutboxDrafts === false && round.result?.outboxDrafts?.length === 0);
  check(`${name}: bounded real provider dispatch`, round.providerRequests?.length > 0 && round.providerRequests.length <= round.budget.maxRequests && round.durationMs <= round.budget.maxSeconds * 1000 + 30000);
  check(`${name}: exact own run event scope`, events(round).length > 0 && events(round).every(event => owned(event) && event.loopRunId === round.result.loopRunId));
  check(`${name}: audit records not truncated`, events(round).every(event => event.metadata?.__truncated !== true));
  check(`${name}: implementation unchanged during run`, Object.entries(round.before?.sourceHashes ?? {}).filter(([path]) => !path.startsWith("apps/web/scripts/"))
    .every(([path, value]) => round.after?.sourceHashes?.[path] === value));
  check(`${name}: runtime and runner source freeze matches campaign`, same(frozenSources(round.before.sourceHashes), frozenSources(session.initial.sourceHashes))
    && same(frozenSources(round.after.sourceHashes), frozenSources(session.initial.sourceHashes)) && same(frozenSources(round.sourceHashes), frozenSources(session.initial.sourceHashes)));
  const bodies = [];
  for (const request of round.providerRequests ?? []) {
    const path = resolve(directory, request.requestBodyFile);
    if (relative(directory, path).startsWith("..") || request.requestBodyFile.includes("/") || request.requestBodyFile.includes("\\")) throw Error("Invalid request body artifact path");
    const stored = JSON.parse(readFileSync(path, "utf8"));
    check(`${name}: provider request ${request.index} payload hash`, hash(stored.payload) === stored.payloadHash && stored.payloadHash === request.payloadHash);
    const succeeded = request.responseStatus >= 200 && request.responseStatus < 300 && request.error === null;
    if (request.kind === "working-memory-agent") check(`${name}: main provider request ${request.index} response`, succeeded);
    else if (!succeeded) dependencyWarnings.push({ round: name, requestIndex: request.index, kind: request.kind,
      status: request.responseStatus, error: request.error, consequence: "Dependency failed or timed out; no claim that every provider request succeeded" });
    if (!succeeded) requestFailures.push({ round: name, ...request });
    bodies.push(stored.payload);
  }
  payloads.set(name, bodies);
  const mapping = verifyDispatchOrder(round);
  check(`${name}: exact prepared-dispatch-result mapping`, mapping.passed, mapping.errors);
  dispatchMappings.push({ round: name, ...mapping });
}
check("four distinct Loop runs", new Set(rounds.map(round => round.result?.loopRunId)).size === 4);
const promotion = read("promotion.json"), initialReview = read("review-initial.json"), correction = read("correction.json");
const originalId = promotion.result?.candidateId, replacementId = correction.result?.newMemory?.id;
const promotionCheck = verifyPromotion({ initial: rounds[0], promotion, ownerId: session.initial.userId,
  workshopId: session.initial.workshopId, loopId: session.initial.loopId });
check("A exact note/source/catalog/prepared/candidate binding", promotionCheck.passed, promotionCheck.errors);
const checkpoint = events(rounds[0]).find(event => event.id === promotion.memory?.memory?.metadata?.workingMemoryPromotion?.checkpointEventId);
check("A notebook persisted before promotion", checkpoint?.type === "working_memory_updated" && checkpoint.metadata?.receiptAuthority === "runtime");
check("A exact Loop note promoted as pending candidate", promotion.command.runKind === "loop" && promotion.command.loopId === session.initial.loopId && promotion.command.runId === rounds[0].result.loopRunId
  && promotion.result.status === "candidate" && promotion.memory.memory.status === "candidate" && promotion.memory.memory.id === originalId);
const sourceRefs = promotion.memory.memory.evidenceRefs;
check("A candidate bound to actual successful source reads", Array.isArray(sourceRefs) && sourceRefs.length > 0 && sourceRefs.every(id => events(rounds[0]).some(event => event.id === id && event.type === "source_checked"
  && event.metadata?.receiptAuthority === "runtime" && event.metadata?.ok === true && event.metadata?.toolName === "webReadPage")));
check("initial review preserves exact content/evidence/category/owner", verifyReview(initialReview, promotion.memory.memory));
check("correction exact replacement body identity and version history", verifyCorrection(correction, initialReview.after.memory));
if (correction.afterNew.memory.status === "candidate") {
  const correctedReview = existsSync(resolve(directory, "review-corrected.json")) ? read("review-corrected.json") : null;
  check("corrected factual candidate explicitly reviewed with unchanged body/owner", verifyReview(correctedReview, correction.afterNew.memory));
}

function workshopContext(roundName) {
  const candidates = payloads.get(roundName).flatMap(textParts).flatMap(text => embeddedObjects(text, "Workshop context:"));
  return candidates.find(value => value.workshop?.id === session.initial.workshopId) ?? null;
}
for (const name of ["A", "B", "C", "D"]) {
  const recall = workshopContext(name)?.memoryRecall;
  for (const route of recall?.routeResults ?? []) if (["failed", "error", "unavailable", "degraded"].includes(route.status)) {
    dependencyWarnings.push({ round: name, kind: "recall-route", route: route.route, status: route.status, hasError: !!route.error });
  }
  if (recall?.fallbackReason || recall?.error) dependencyWarnings.push({ round: name, kind: "recall-fallback", backend: recall.backend,
    reason: recall.fallbackReason ?? "recall_error", hasError: !!recall.error });
}
const contextB = workshopContext("B");
check("B original memory actually selected by Brain", contextB?.memoryRecall?.backend === "brain" && contextB.memoryRecall.contextPack?.selected?.some(item => item.id === originalId));
check("B exact reviewed body and version supplied as current memory", contextB?.memoryContext?.taskRelevantMemories?.some(item => item.id === originalId
  && item.content === initialReview.after.memory.content && item.revisionVersion === initialReview.after.expectedVersion));
for (let index = 1; index < rounds.length; index++) {
  const round = rounds[index], previous = rounds[index - 1];
  const inherited = events(round).find(event => event.type === "working_memory_continuity_loaded" && event.metadata?.receiptAuthority === "runtime" && event.metadata?.status === "inherited");
  const skipped = events(round).find(event => ["working_memory_continuity_loaded", "working_memory_continuity_skipped"].includes(event.type) && event.metadata?.receiptAuthority === "runtime" && event.metadata?.status === "skipped");
  check(`${round.round}: historical notebook has explicit load/skip audit`, !!inherited || !!skipped);
  if (inherited) {
    const checkpoint = inherited.metadata.checkpoint;
    const chain = checkpoint?.chain ?? inherited.metadata.chain;
    const priorRunMatched = checkpoint?.sourceRunId === previous.result.loopRunId || Array.isArray(chain?.viaRunIds) && chain.viaRunIds.includes(previous.result.loopRunId);
    check(`${round.round}: notebook inherited through exact previous run`, inherited.metadata.status === "inherited" && priorRunMatched
      && checkpoint?.loopId === session.initial.loopId && checkpoint?.authority === "historical-model-authored-unverified");
    const actualHistory = payloads.get(round.round).flatMap(continuityFromPayload);
    const auditedHistory = continuityAuditResult(inherited.metadata);
    check(`${round.round}: exact audited historical checkpoint reached real input`, actualHistory.length > 0 && actualHistory.every(value => same(value, auditedHistory)));
    if (["C", "D"].includes(round.round)) {
      const history = checkpoint?.history;
      check(`${round.round}: current correction suppresses historical assertions`, checkpoint?.chain?.assertionsSuppressed === true
        && history?.facts?.length === 0 && history?.hypotheses?.length === 0 && history?.nextAction === null);
    }
  } else {
    // A transparent skip is safe, but does not establish continuity.
    check(`${round.round}: historical notebook was available`, false, skipped?.metadata?.reason ?? "unknown");
  }
  if (previous.after?.state && round.before?.state) {
    check(`${round.round}: durable Loop state read back between runs`, hash(previous.after.state) === hash(round.before.state));
    const durable = payloads.get(round.round).flatMap(textParts).flatMap(text => embeddedObjects(text, "Current durable state:"));
    check(`${round.round}: exact persisted progress identity in supplied durable state`, durable.length > 0 && durable.every(value => value.stateJson?.lastLoopRunId === previous.result.loopRunId));
    const priorAction = previous.after.state.nextAction;
    if (typeof priorAction === "string" && priorAction.length > 0) {
      check(`${round.round}: durable next action reached actual model input`, payloads.get(round.round).some(payload => textParts(payload).some(text => text.includes(priorAction))));
    } else {
      // A completed Loop's deterministic checker currently clears nextAction.
      // Verify the actual persisted progress identity instead of inventing a missing model checkpoint field.
      const priorRunId = previous.after.state.stateJson?.lastLoopRunId;
      check(`${round.round}: durable previous run identity reached actual model input`, priorRunId === previous.result.loopRunId
        && payloads.get(round.round).some(payload => textParts(payload).some(text => text.includes(priorRunId))));
    }
  } else check(`${round.round}: durable Loop state exists`, false);
}
for (const name of ["C", "D"]) {
  const context = workshopContext(name), selected = context?.memoryRecall?.contextPack?.selected ?? [];
  check(`${name}: replacement selected and old version excluded`, context?.memoryRecall?.backend === "brain" && selected.some(item => item.id === replacementId) && !selected.some(item => item.id === originalId));
  const reviewedReplacement = existsSync(resolve(directory, "review-corrected.json")) ? read("review-corrected.json").after : correction.afterNew;
  check(`${name}: exact corrected body and current version supplied`, context?.memoryContext?.taskRelevantMemories?.some(item => item.id === replacementId
    && item.content === correction.request.content && item.revisionVersion === reviewedReplacement.expectedVersion)
    && !context?.memoryContext?.taskRelevantMemories?.some(item => item.id === originalId));
}
const required = correction.evaluationAssertions?.outputIncludes ?? [], forbidden = correction.evaluationAssertions?.outputExcludes ?? [];
const outputText = round => [round.result?.result?.output, round.result?.result?.result?.structuredReport?.summary,
  round.result?.result?.result?.structuredReport?.finalMarkdownReport].filter(value => typeof value === "string").join("\n");
const modelUseChecks = ["C", "D"].map(name => {
  const output = outputText(rounds.find(round => round.round === name));
  return { round: name, passed: required.length > 0 && forbidden.length > 0 && required.every(text => output.includes(text)) && forbidden.every(text => !output.includes(text)),
    interpretation: "Only the explicit fixture output assertions are checked; this is not a general task quality score" };
});
if (!required.length || !forbidden.length) warnings.push("No predeclared output assertion pair: input recall can be checked, correct model use remains inconclusive.");
const usage = rounds.map(round => {
  const receipts = events(round).filter(event => event.type === "working_memory_usage" && event.metadata?.receiptAuthority === "runtime").map(event => event.metadata);
  const mainRequests = round.providerRequests.filter(request => request.kind === "working-memory-agent");
  const mainComplete = mainRequests.length > 0 && receipts.length === mainRequests.length && receipts.every(receipt => receipt.usageStatus === "reported" && receipt.source === "sdk_result"
    && ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens"].every(key => Number.isSafeInteger(receipt[key]) && receipt[key] >= 0));
  const complete = mainComplete && mainRequests.length === round.providerRequests.length;
  const subtotal = key => {
    const values = receipts.map(receipt => receipt[key]).filter(value => Number.isSafeInteger(value) && value >= 0);
    return values.length ? values.reduce((total, value) => total + value, 0) : null;
  };
  return { round: round.round, status: complete ? "reported" : "unknown_or_partial", providerRequests: round.providerRequests.length,
    mainUsageStatus: mainComplete ? "reported" : "unknown_or_partial",
    mainProviderRequests: mainRequests.length, usageReceipts: receipts.length,
    inputTokens: complete ? receipts.reduce((total, receipt) => total + receipt.inputTokens, 0) : null,
    outputTokens: complete ? receipts.reduce((total, receipt) => total + receipt.outputTokens, 0) : null,
    cacheReadTokens: complete ? receipts.reduce((total, receipt) => total + receipt.cacheReadTokens, 0) : null,
    totalTokens: complete ? receipts.reduce((total, receipt) => total + receipt.totalTokens, 0) : null,
    reportedSdkSubtotal: receipts.length ? { inputTokens: subtotal("inputTokens"), outputTokens: subtotal("outputTokens"),
      cacheReadTokens: subtotal("cacheReadTokens"), totalTokens: subtotal("totalTokens"), isCompleteTotal: complete } : null,
    priceUsd: null };
});
if (usage.some(item => item.status !== "reported")) warnings.push("Actual usage is incomplete for one or more rounds; missing tokens and monetary cost are unknown, never zero.");
const result = { schemaVersion: "memory-continuity-independent-review.v1", reviewedAt: new Date().toISOString(),
  mechanismPassed: checks.every(item => item.passed), modelUsePassed: modelUseChecks.every(item => item.passed),
  usageComplete: usage.every(item => item.status === "reported"), checks, modelUseChecks, usage, warnings, dependencyWarnings, requestFailures, dispatchMappings, promotionCheck,
  realProviderRequests: rounds.reduce((total, round) => total + round.providerRequests.length, 0),
  claims: { naturalTaskQualityImproved: false, generalResearchAccuracyProved: false, costReduced: false, productionDeploymentVerified: false },
  sourceSeal: { runtimeAndRunner: frozenSources(session.initial.sourceHashes),
    independentVerifierAtReview: Object.fromEntries(["apps/web/scripts/verify-memory-continuity.mjs", "apps/web/scripts/lib/memory-continuity-verification.mjs", "apps/web/scripts/lib/memory-continuity-verification.test.mjs"]
      .map(path => [path, hash(readFileSync(resolve(repository, path), "utf8"))])),
    verifierRevisionChangesRuntimeInput: false },
  artifactHashes: Object.fromEntries(["session.json", "round-A.json", "round-B.json", "round-C.json", "round-D.json", "promotion.json", "review-initial.json", "correction.json",
    ...(existsSync(resolve(directory, "review-corrected.json")) ? ["review-corrected.json"] : []),
    ...rounds.flatMap(round => round.providerRequests.map(request => request.requestBodyFile))]
    .map(name => [name, hash(readFileSync(resolve(directory, name), "utf8"))])) };
result.mainUsageComplete = usage.every(item => item.mainUsageStatus === "reported");
result.status = !result.mechanismPassed || !result.modelUsePassed ? "failed" : !result.mainUsageComplete ? "inconclusive_main_usage"
  : dependencyWarnings.length ? "mechanism_verified_dependencies_degraded" : !result.usageComplete ? "mechanism_verified_auxiliary_usage_unknown" : "verified";
result.passed = result.status === "verified";
const resultFile = resolve(directory, `independent-review-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(resultFile, JSON.stringify(result, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
console.log(JSON.stringify({ status: result.status, passed: result.passed, mechanismPassed: result.mechanismPassed, modelUsePassed: result.modelUsePassed, usageComplete: result.usageComplete,
  failedChecks: checks.filter(item => !item.passed).map(item => ({ name: item.name, detail: item.detail })), resultFile }));
if (!result.passed) process.exitCode = 1;
