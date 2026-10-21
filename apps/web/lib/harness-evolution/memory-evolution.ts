import { resolveWorkingMemoryStrategy } from "@/lib/workshops/working-memory-strategy";
import { sha256Canonical } from "./canonical-json";
import { createHarnessChangeProposal } from "./proposals";
import { harnessEvolutionRepository, type HarnessEvolutionRepository, type ResolvedPersistedHarnessSnapshot } from "./repository";
import type { CapturedRunEventFact, HarnessChangeProposalV2, RunEvidenceBundle } from "./types";

type Strategy = ReturnType<typeof resolveWorkingMemoryStrategy>["strategy"];

export interface MemoryTrajectoryDiagnosis {
  interfaceVersion: "memory-trajectory-diagnosis.v1";
  workId: string;
  evidenceBundleId: string;
  status: "completed" | "inconclusive";
  policyHash: string;
  observations: Array<{ cause: "duplicate_notes" | "summary_budget" | "host_or_source_block"; eventIds: string[] }>;
  unknowns: string[];
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function duplicateNotes(event: CapturedRunEventFact) {
  const state = object(event.metadata.state);
  const notes = [state.facts, state.hypotheses].flatMap((items) => Array.isArray(items) ? items : []);
  const seen = new Set<string>();
  return notes.some((value) => {
    const note = object(value);
    if (typeof note.text !== "string" || !Array.isArray(note.evidenceIds)) return false;
    const key = sha256Canonical({ text: note.text.trim().replace(/\s+/g, " ").toLowerCase(), evidence: [...note.evidenceIds].sort() });
    if (seen.has(key)) return true;
    seen.add(key); return false;
  });
}

/** Diagnoses host receipts, never re-labels model claims as verified observations. */
export function diagnoseMemoryTrajectory(input: {
  bundle: RunEvidenceBundle;
  events: CapturedRunEventFact[];
  policyHash: string;
}): MemoryTrajectoryDiagnosis {
  const unknowns: string[] = [];
  if (input.bundle.runtime.tokenUsageStatus !== "reported") unknowns.push("actual_provider_usage_unknown");
  const events = input.events.filter((event) => event.metadata.receiptAuthority === "runtime" &&
    object(event.metadata.policyIdentity).hash === input.policyHash);
  if (events.length === 0) unknowns.push("no_matching_runtime_memory_receipts");
  if (input.bundle.completeness !== "complete") unknowns.push("trajectory_evidence_incomplete");
  const duplicates = events.filter((event) => event.type === "working_memory_updated" && duplicateNotes(event));
  const limits = events.filter((event) => event.type === "working_memory_rejected" &&
    (event.metadata.reason === "summary_limit" || event.metadata.code === "summary_limit"));
  const blocked = events.filter((event) => event.type === "working_memory_rejected" &&
    ["unknown_evidence", "unsafe_prune", "audit_failed", "incomplete_group"].includes(String(event.metadata.reason ?? event.metadata.code)));
  const observations: MemoryTrajectoryDiagnosis["observations"] = [];
  if (duplicates.length) observations.push({ cause: "duplicate_notes", eventIds: duplicates.map((event) => event.id) });
  if (limits.length) observations.push({ cause: "summary_budget", eventIds: limits.map((event) => event.id) });
  if (blocked.length || input.bundle.observations.providerWarnings.length) observations.push({ cause: "host_or_source_block", eventIds: blocked.map((event) => event.id) });
  return {
    interfaceVersion: "memory-trajectory-diagnosis.v1", workId: input.bundle.workId,
    evidenceBundleId: input.bundle.id, policyHash: input.policyHash,
    status: events.length > 0 && input.bundle.completeness === "complete" ? "completed" : "inconclusive",
    observations, unknowns,
  };
}

/** The optimizer's exact allowlist. All mission, source and permission fields remain immutable. */
export function assertBoundedMemoryStrategyChange(before: unknown, after: unknown) {
  const base = resolveWorkingMemoryStrategy(before);
  const candidate = resolveWorkingMemoryStrategy(after);
  if (base.issues.length || candidate.issues.length) throw new Error("A complete valid memory strategy is required.");
  for (const key of ["schemaVersion", "noteFormat", "index"] as const) {
    if (base.strategy[key] !== candidate.strategy[key]) throw new Error(`Protected memory strategy field: ${key}`);
  }
  if (base.identity.hash === candidate.identity.hash) throw new Error("The candidate does not change its memory strategy.");
  if (base.strategy.version === candidate.strategy.version) throw new Error("Memory strategy candidates require a new version.");
  return candidate;
}

export async function proposeMemoryPolicyCandidates(input: {
  baseline: ResolvedPersistedHarnessSnapshot;
  bundle: RunEvidenceBundle;
  events: CapturedRunEventFact[];
  evaluationSuiteId: string;
  developmentScenarioIds: string[];
  repository?: HarnessEvolutionRepository;
}): Promise<{ diagnosis: MemoryTrajectoryDiagnosis; proposals: HarnessChangeProposalV2[] }> {
  const component = input.baseline.components.find((item) => item.key === "work.context-policy" && item.type === "context_policy");
  if (!component || component.mutability !== "owner_editable" || component.riskLevel === "protected") throw new Error("No editable memory context component is available.");
  if (input.baseline.status !== "active" || input.bundle.workId !== input.baseline.workshopId ||
    input.bundle.harnessSnapshotId !== input.baseline.id || input.bundle.componentSetHash !== input.baseline.componentSetHash) throw new Error("Memory trajectory baseline or work scope differs.");
  const resolved = resolveWorkingMemoryStrategy(component.content.memoryUsageContract);
  if (resolved.issues.length) throw new Error("The active memory strategy is invalid.");
  const diagnosis = diagnoseMemoryTrajectory({ bundle: input.bundle, events: input.events, policyHash: resolved.identity.hash });
  if (diagnosis.status === "inconclusive") return { diagnosis, proposals: [] };
  if (!input.evaluationSuiteId || input.developmentScenarioIds.length === 0) throw new Error("Development scenarios are required; holdout is selected by the evaluator only.");
  const candidates: Array<{ cause: string; strategy: Strategy; metric: string }> = [];
  const causes = new Set(diagnosis.observations.map((observation) => observation.cause));
  if (causes.has("duplicate_notes") && resolved.strategy.deduplication !== "normalized-text-evidence") {
    candidates.push({ cause: "duplicate_notes", strategy: { ...resolved.strategy, deduplication: "normalized-text-evidence" }, metric: "noteUniquenessScore" });
  }
  if (causes.has("summary_budget") && resolved.strategy.budget.maxSummaryChars < 12_000) {
    candidates.push({ cause: "summary_budget", strategy: { ...resolved.strategy,
      budget: { ...resolved.strategy.budget, maxSummaryChars: Math.min(12_000, Math.ceil(resolved.strategy.budget.maxSummaryChars * 1.25)) } }, metric: "validNoteCompletionScore" });
  }
  const repository = input.repository ?? harnessEvolutionRepository;
  const suite = await repository.getEvaluationSuite(input.evaluationSuiteId);
  if (!suite || suite.status !== "active" || (suite.ownerType === "user" && suite.userId !== input.bundle.userId) ||
    input.developmentScenarioIds.some((id) => !suite.scenarios.some((scenario) =>
    (scenario.id === id || scenario.scenarioKey === id) && scenario.status === "active" && scenario.riskTier !== "holdout"))) {
    throw new Error("Candidate development scenarios must belong to the active public suite; holdout is sealed.");
  }
  const proposals: HarnessChangeProposalV2[] = [];
  for (const candidate of candidates.slice(0, 2)) {
    const causeEvidence = diagnosis.observations.find((observation) => observation.cause === candidate.cause)!;
    const candidateHash = sha256Canonical({ workId: input.bundle.workId, baseSnapshot: input.baseline.id, base: resolved.identity.hash, cause: candidate.cause, strategy: candidate.strategy });
    const candidateId = `${candidateHash.slice(0, 8)}-${candidateHash.slice(8, 12)}-5${candidateHash.slice(13, 16)}-${((Number.parseInt(candidateHash[16], 16) & 3) | 8).toString(16)}${candidateHash.slice(17, 20)}-${candidateHash.slice(20, 32)}`;
    const strategy = { ...candidate.strategy, version: `${resolved.strategy.version.slice(0, 80)}.${candidate.cause}.${candidateHash.slice(0, 8)}` };
    assertBoundedMemoryStrategyChange(resolved.strategy, strategy);
    const scenarioIds = [...new Set(input.developmentScenarioIds)];
    const proposal = createHarnessChangeProposal({
      id: candidateId, workId: input.bundle.workId, scope: "work", affectedWorkIds: [input.bundle.workId],
      baseWorkVersionId: input.baseline.workVersionId, baseHarnessSnapshotId: input.baseline.id, baseComponentSetHash: input.baseline.componentSetHash,
      proposedBy: "workshop_agent", riskLevel: "low", failurePattern: candidate.cause,
      evidenceRefs: [{ kind: "workshop_run", id: input.bundle.workRunId ?? input.bundle.loopRunId!, claim: `Runtime memory diagnosis ${input.bundle.id}; events ${causeEvidence.eventIds.join(", ")}`,
        observedAt: input.bundle.runtime.completedAt, freshness: input.bundle.observations.freshness, integrity: "verified" }],
      rootCauseHypothesis: `Under the matched source snapshot, ${candidate.cause} limits note use; changing only the bounded memory strategy should improve ${candidate.metric}. Independent quality or boundary regression refutes the hypothesis.`,
      changes: [{ componentId: component.componentId, componentType: "context_policy", beforeRevisionId: component.revisionId,
        componentMutability: component.mutability, componentRiskLevel: component.riskLevel,
        patch: { memoryUsageContract: strategy }, rationale: `Observed in runtime events: ${causeEvidence.eventIds.join(", ")}` }],
      predictedFixes: scenarioIds.map((scenarioId) => ({ scenarioId, expectedDirection: "improve", metric: candidate.metric, threshold: 0, rationale: "Independent matched development evaluation must confirm improvement." })),
      predictedRegressions: scenarioIds.map((scenarioId) => ({ scenarioId, expectedDirection: "unchanged", metric: "taskScore", threshold: 0, rationale: "Evidence-supported task quality must not decrease." })),
      successMetrics: scenarioIds.map((scenarioId) => ({ scenarioId, metric: "taskScore", operator: "no_regression", target: 0, severity: "guardrail" })),
      evaluationSuiteId: input.evaluationSuiteId, evaluationScenarioIds: scenarioIds,
      evaluationWindow: { evaluatorId: "isolated-memory-model/v1", maximumCandidates: 2, developmentOnly: true, actualUsageRequired: true, diagnosis },
      rollbackPlan: { strategy: "restore_component_revision", targetRevisionIds: [component.revisionId],
        triggerConditions: ["hard_invariant_failure", "independent_quality_regression", "missing_actual_usage", "loaded_policy_hash_mismatch"], verificationScenarioIds: scenarioIds, ownerApprovalRequired: true },
      attributionLimited: false,
    });
    const existing = await repository.getProposal(input.bundle.workId, proposal.id);
    // Preserve the previous review/failure instead of reopening the same candidate on every run.
    proposals.push(existing ?? await repository.persistProposal(proposal));
  }
  return { diagnosis, proposals };
}
