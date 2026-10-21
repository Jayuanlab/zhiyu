import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_WORKING_MEMORY_STRATEGY, resolveWorkingMemoryStrategy,
} from "@/lib/workshops/working-memory-strategy";
import {
  activateMemoryPolicy, assertBoundedMemoryStrategyChange, createIsolatedMemoryScenarioExecutor,
  diagnoseMemoryTrajectory, hashFrozenMemorySource, proposeMemoryPolicyCandidates,
  readActiveMemoryPolicyBinding, rollbackMemoryPolicy, sha256Canonical,
} from "@/lib/harness-evolution";
import type { HarnessEvolutionRepository, MemoryModelScenarioTrace, MemoryPolicyBindingDependencies,
  ResolvedPersistedHarnessSnapshot, RunEvidenceBundle, HarnessChangeProposalV2 } from "@/lib/harness-evolution";
import type { UpdateWorkCommand } from "@/lib/work-runtime/types";
type MemoryRunnerRequest = Parameters<Parameters<typeof createIsolatedMemoryScenarioExecutor>[0]["runner"]["execute"]>[0];

function strategy(version = "baseline.v1", deduplication = "exact-text-evidence" as "exact-text-evidence" | "normalized-text-evidence") {
  return { ...structuredClone(DEFAULT_WORKING_MEMORY_STRATEGY), version, deduplication };
}

function snapshot(status = "active", policy = strategy()): ResolvedPersistedHarnessSnapshot {
  return {
    id: status === "active" ? "snapshot-base" : "snapshot-candidate", workshopId: "work-1", workVersionId: "work-version-1",
    platformVersion: "platform-1", componentSetHash: status === "active" ? "set-base" : "set-candidate", status, resolvedAt: new Date("2026-10-13T00:00:00Z"),
    modelRuntime: { provider: "test", model: "fixed", reasoningLevel: null },
    policySummary: { allowedActions: ["read"], approvalRequiredActions: ["external_send"], deniedActions: ["real_funds"], protectedComponentIds: ["mission-1"] },
    components: [{ key: "work.context-policy", componentId: "context-1", revisionId: status === "active" ? "revision-1" : "revision-2", revision: 1, checksum: "checksum",
      type: "context_policy", scope: { type: "work", id: "work-1" }, owner: "work", mutability: "owner_editable", riskLevel: "low", sourceKind: "database",
      sourceRef: "work:memory", sourceVersion: "work-v1", content: { memoryUsageContract: policy, contextTokenBudget: 10000 } },
    { key: "work.prompt", componentId: "mission-1", revisionId: "mission-revision-1", revision: 1, checksum: "mission-checksum", type: "prompt",
      scope: { type: "work", id: "work-1" }, owner: "work", mutability: "proposal_only", riskLevel: "medium", sourceKind: "database",
      sourceRef: "work:mission", sourceVersion: "work-v1", content: { mission: "Research only", role: "researcher" } }],
  };
}

function bundle(): RunEvidenceBundle {
  return {
    interfaceVersion: "run-evidence.v1", id: "evidence-1", userId: "owner-1", workId: "work-1", workRunId: "run-1", loopId: null, loopRunId: null,
    workVersionId: "work-version-1", harnessSnapshotId: "snapshot-base", componentSetHash: "set-base",
    runtime: { model: "fixed", startedAt: "2026-10-13T00:00:00Z", completedAt: "2026-10-13T00:00:01Z", durationMs: 1000, tokenUsage: {}, tokenUsageStatus: "unknown", attemptCount: 1 },
    observations: { sourceEventIds: ["source-1"], freshness: "fresh", providerWarnings: [] },
    actions: { toolCallCount: 1, toolNames: ["read"], deniedCount: 0, approvalCount: 0, externalActionCount: 0 },
    outcome: { status: "completed", verifierPassed: true, requiredFieldsMissing: [], artifacts: [], errorClass: null },
    evidenceRefs: [{ kind: "workshop_run", id: "run-1", claim: "Actual runtime receipt", observedAt: "2026-10-13T00:00:01Z", freshness: "fresh", integrity: "verified" }],
    captureStatus: "finalized", completeness: "complete", warnings: [], createdAt: "2026-10-13T00:00:01Z",
  };
}

function events() {
  const policyIdentity = resolveWorkingMemoryStrategy(strategy()).identity;
  return [{ id: "duplicate-1", type: "working_memory_updated", createdAt: "2026-10-13T00:00:00Z", metadata: {
    receiptAuthority: "runtime", policyIdentity, state: { facts: [{ text: "Same fact", evidenceIds: ["source-1"] }, { text: " same   fact ", evidenceIds: ["source-1"] }] },
  } }, { id: "limit-1", type: "working_memory_rejected", createdAt: "2026-10-13T00:00:00Z", metadata: {
    receiptAuthority: "runtime", policyIdentity, reason: "summary_limit",
  } }];
}

const publicSuite = { status: "active", ownerType: "system", userId: null, scenarios: [{ id: "development-1", scenarioKey: "development-1", status: "active", riskTier: "normal" },
  { id: "holdout-1", scenarioKey: "holdout-1", status: "active", riskTier: "holdout" }] };

describe("memory trajectory optimization contract", () => {
  it("preserves unknown cost and never treats unmatched/model-authored receipts as optimization evidence", () => {
    const input = events();
    input[0].metadata.receiptAuthority = "model";
    const result = diagnoseMemoryTrajectory({ bundle: bundle(), events: [input[0]], policyHash: resolveWorkingMemoryStrategy(strategy()).identity.hash });
    expect(result.status).toBe("inconclusive");
    expect(result.observations).toEqual([]);
    expect(result.unknowns).toContain("actual_provider_usage_unknown");
  });

  it("creates at most two reviewable proposals without granting tools or exposing holdout content", async () => {
    const persistProposal = vi.fn(async (proposal: HarnessChangeProposalV2) => proposal);
    const result = await proposeMemoryPolicyCandidates({ baseline: snapshot(), bundle: bundle(), events: events(),
      evaluationSuiteId: "suite-1", developmentScenarioIds: ["development-1"], repository: { persistProposal, getProposal: async () => null, getEvaluationSuite: async () => publicSuite } as unknown as HarnessEvolutionRepository });
    expect(result.proposals).toHaveLength(2);
    expect(result.proposals.every((proposal) => /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(proposal.id))).toBe(true);
    expect(result.proposals.every((proposal) => proposal.status === "proposed")).toBe(true);
    expect(result.proposals.every((proposal) => Object.keys(proposal.changes[0].patch).join() === "memoryUsageContract")).toBe(true);
    expect(result.proposals[0].evaluationScenarioIds).toEqual(["development-1"]);
    expect(JSON.stringify(result.proposals)).not.toContain("allowedActions");
  });

  it("rejects cross-work trajectories and protected or unknown memory fields", async () => {
    const wrong = bundle(); wrong.workId = "other-work";
    await expect(proposeMemoryPolicyCandidates({ baseline: snapshot(), bundle: wrong, events: events(), evaluationSuiteId: "suite-1", developmentScenarioIds: ["development-1"] })).rejects.toThrow("scope differs");
    expect(() => assertBoundedMemoryStrategyChange(strategy(), { ...strategy("candidate.v1"), denied: [] })).toThrow("valid memory strategy");
    expect(() => assertBoundedMemoryStrategyChange(strategy(), { ...strategy(), budget: { ...strategy().budget, maxSummaryChars: 8000 } })).toThrow("new version");
  });

  it("keeps holdout scenarios out of the candidate optimizer", async () => {
    const persistProposal = vi.fn();
    await expect(proposeMemoryPolicyCandidates({ baseline: snapshot(), bundle: bundle(), events: events(), evaluationSuiteId: "suite-1", developmentScenarioIds: ["holdout-1"],
      repository: { persistProposal, getEvaluationSuite: async () => publicSuite } as unknown as HarnessEvolutionRepository })).rejects.toThrow("holdout is sealed");
    expect(persistProposal).not.toHaveBeenCalled();
  });
});

function scenarioFixture(options: { unknownUsage?: boolean; missingProviderRequest?: boolean; persistFailure?: boolean } = {}) {
  const source = { id: "source-1", content: "Frozen evidence", contentHash: hashFrozenMemorySource("Frozen evidence"), observedAt: "2026-10-13T00:00:00Z", provider: "fixture", warning: "Source observation requires independent verification." };
  const { content: _content, ...metadata } = source;
  const runtime = { provider: "test", model: "fixed", sourceSnapshotHash: sha256Canonical([metadata]), toolContractHash: "frozen-tools", allowedTools: ["read", "workingMemory"], deniedTools: ["external_send"], budget: { maxModelCalls: 2, maxTotalTokens: 100, maxDurationMs: 1000 } };
  const receipts: unknown[] = [];
  const execute = vi.fn(async (request: MemoryRunnerRequest): Promise<MemoryModelScenarioTrace> => ({
    runId: "model-run-1", status: "success", output: "Evidence-supported answer", actualRuntimeHash: request.runtimeHash, loadedPolicyHash: request.policyHash,
    providerRequests: options.missingProviderRequest ? [] : [{ requestId: "provider-call-1", payloadHash: "actual-input-hash", model: "fixed" }],
    usage: options.unknownUsage ? null : { source: "sdk", completeness: "complete", inputTokens: 20, outputTokens: 5, totalTokens: 25 }, durationMs: 100,
    actions: ["read", "workingMemory"], memoryOperations: [{ operation: "update", eventId: "memory-event-1", policyHash: request.policyHash }], sourceRefs: ["source-1"], warnings: [],
  }));
  const executor = createIsolatedMemoryScenarioExecutor({ runtime, policies: { baseline: strategy(), candidate: strategy("candidate.v1", "normalized-text-evidence") },
    loadSources: async () => [source], runner: { kind: "pi-harness", execute },
    verifier: { id: "independent-source-verifier", verify: async () => ({ passed: true, failures: [], metrics: { taskScore: 1 } }) },
    persistReceipt: async (receipt) => { if (options.persistFailure) throw new Error("audit unavailable"); receipts.push(receipt); return { evidenceBundleId: "model-evidence-1" }; },
  });
  const scenario = { scenarioKey: "development-1", name: "Frozen source scenario", mode: "dry_run" as const, tags: ["memory"], riskTier: "normal" as const, fixtureRef: "frozen-source-1",
    preconditions: {}, taskIntent: "Use frozen evidence", expectedArtifacts: [], hardInvariants: [], forbiddenActions: ["external_send"], metrics: ["taskScore"], repetitions: 1, timeoutMs: 1000, status: "active" as const };
  return { executor, execute, receipts, request: { scenario, cohort: "candidate" as const, repetition: 1, runtimeContract: { memoryRuntimeHash: executor.runtimeHash },
    allowExternalActions: false as const, allowRealFunds: false as const, allowDestructiveActions: false as const } };
}

describe("isolated Pi memory executor contract (injected unit runner)", () => {
  it("binds frozen sources and policy, uses independent verification, and persists actual receipts including memory cost", async () => {
    const fixture = scenarioFixture();
    const result = await fixture.executor.execute(fixture.request);
    expect(result).toMatchObject({ status: "success", usageStatus: "reported", evidenceBundleId: "model-evidence-1", metrics: { taskScore: 1, tokenCostScore: -25 } });
    expect(fixture.receipts[0]).toMatchObject({ evaluatorKind: "isolated-memory-model/v1", outputHash: hashFrozenMemorySource("Evidence-supported answer"), usage: { totalTokens: 25 } });
  });

  it("keeps missing usage unknown and never substitutes a character estimate", async () => {
    const fixture = scenarioFixture({ unknownUsage: true });
    const result = await fixture.executor.execute(fixture.request);
    expect(result.usageStatus).toBe("unknown");
    expect(result.metrics.tokenCostScore).toBeUndefined();
    expect(result.warnings?.some((warning) => warning.includes("unknown"))).toBe(true);
  });

  it("rejects missing actual requests, changed runtime, audit failure, and aborted execution", async () => {
    const fixture = scenarioFixture({ missingProviderRequest: true });
    expect((await fixture.executor.execute(fixture.request)).hardInvariantFailures).toContain("actual_provider_request_missing");
    await expect(fixture.executor.execute({ ...fixture.request, runtimeContract: { memoryRuntimeHash: "changed" } })).rejects.toThrow("differs");
    const audit = scenarioFixture({ persistFailure: true });
    await expect(audit.executor.execute(audit.request)).rejects.toThrow("audit unavailable");
    const controller = new AbortController(); controller.abort();
    await expect(fixture.executor.execute({ ...fixture.request, signal: controller.signal })).rejects.toThrow();
  });
});

async function bindingFixture() {
  const created = await proposeMemoryPolicyCandidates({ baseline: snapshot(), bundle: bundle(), events: events(), evaluationSuiteId: "suite-1", developmentScenarioIds: ["development-1"],
    repository: { persistProposal: async (proposal: HarnessChangeProposalV2) => proposal, getProposal: async () => null, getEvaluationSuite: async () => publicSuite } as unknown as HarnessEvolutionRepository });
  const proposal = { ...created.proposals[0], status: "confirmed" as const };
  const candidateStrategy = proposal.changes[0].patch.memoryUsageContract as ReturnType<typeof strategy>;
  const candidate = snapshot("candidate", candidateStrategy);
  const campaign = { id: "campaign-1", status: "passed", changeProposalId: proposal.id, baselineHarnessSnapshotId: "snapshot-base", candidateHarnessSnapshotId: "snapshot-candidate",
    summary: { evaluatorKind: "isolated-memory-model/v1", evaluation: { status: "passed", hardInvariantFailures: [] }, usage: { unknownRunCount: 0, estimated: false }, holdoutScenarioIds: ["holdout-1"] } };
  const repository = { getProposal: async () => proposal, getEvaluationCampaign: async () => campaign,
    getResolvedSnapshot: async (_work: string, id: string) => id === "snapshot-base" ? snapshot() : candidate, getLatestSnapshot: async () => snapshot(),
    listEvaluationRuns: async () => ["baseline", "candidate"].map((cohort) => ({ cohort, scenarioId: "holdout-1", status: "success", evidenceBundleId: `holdout-evidence-${cohort}` })),
  } as unknown as HarnessEvolutionRepository;
  let baseline = { workshop: { id: "work-1", userId: "owner-1", status: "paused", modelConfig: { memoryUsageContract: strategy(), unrelatedSetting: true } as Record<string, unknown> }, commandVersion: 7 };
  const commands = new Map<string, UpdateWorkCommand>();
  const update = vi.fn(async (command: UpdateWorkCommand) => {
    commands.set(command.commandId!, structuredClone(command));
    baseline = { workshop: { ...baseline.workshop, modelConfig: command.patch.modelConfig ?? {} }, commandVersion: baseline.commandVersion + 1 };
  });
  const dependencies: MemoryPolicyBindingDependencies = { baseline: async () => structuredClone(baseline), update,
    receipt: async (_userId, commandId) => { const command = commands.get(commandId); return command ? { workId: "work-1", type: "updateWork", status: "succeeded", command } : null; } };
  const input = { principal: { kind: "owner" as const, userId: "owner-1" }, workshopId: "work-1", proposalId: proposal.id, campaignId: "campaign-1", commandId: "activate-1", expectedVersion: 7, repository, dependencies };
  return { input, dependencies, update, campaign, candidate, read: () => baseline };
}

describe("owner-governed memory binding", () => {
  it("uses an idempotent versioned owner command, reads the loaded policy back and restores the exact baseline without resuming a paused work", async () => {
    const fixture = await bindingFixture();
    const result = await activateMemoryPolicy(fixture.input);
    expect(result.status).toBe("loaded");
    expect(fixture.update.mock.calls[0][0]).toMatchObject({ source: "owner", expectedVersion: 7, commandId: "activate-1" });
    expect(fixture.read().workshop.status).toBe("paused");
    expect(fixture.read().workshop.modelConfig.unrelatedSetting).toBe(true);
    const restored = await rollbackMemoryPolicy({ ...fixture.input, expectedVersion: 8, commandId: "rollback-1" });
    expect(restored.identity).toEqual(resolveWorkingMemoryStrategy(strategy()).identity);
    expect(fixture.read().workshop.modelConfig.memoryPolicyBinding).toBeUndefined();
    expect(fixture.read().workshop.status).toBe("paused");
  });

  it("rejects fixture-only evaluation, unknown cost, missing holdout and protected component changes before any write", async () => {
    const fixture = await bindingFixture();
    fixture.campaign.summary.evaluatorKind = "builtin-deterministic-v1";
    await expect(activateMemoryPolicy(fixture.input)).rejects.toThrow("Real model evaluation");
    fixture.campaign.summary.evaluatorKind = "isolated-memory-model/v1";
    fixture.campaign.summary.usage.unknownRunCount = 1;
    await expect(activateMemoryPolicy(fixture.input)).rejects.toThrow("Real model evaluation");
    fixture.campaign.summary.usage.unknownRunCount = 0;
    fixture.campaign.summary.holdoutScenarioIds = [];
    await expect(activateMemoryPolicy(fixture.input)).rejects.toThrow("holdout");
    fixture.campaign.summary.holdoutScenarioIds = ["holdout-1"];
    fixture.candidate.components[1].content.mission = "Transfer funds";
    await expect(activateMemoryPolicy(fixture.input)).rejects.toThrow("protected Harness");
    expect(fixture.update).not.toHaveBeenCalled();
  });

  it("rejects agent principals, stale command versions and mismatched loaded bindings", async () => {
    const fixture = await bindingFixture();
    await expect(activateMemoryPolicy({ ...fixture.input, principal: { kind: "workshop_agent", userId: "owner-1" } as never })).rejects.toThrow("owner principal");
    await expect(activateMemoryPolicy({ ...fixture.input, expectedVersion: 6 })).rejects.toThrow("concurrently");
    expect(readActiveMemoryPolicyBinding({ schemaVersion: "memory-policy-binding.v1", status: "active", workshopId: "other-work", version: "v", hash: "bad" }, "work-1", { version: "v", hash: "good" }).valid).toBe(false);
    expect(fixture.update).not.toHaveBeenCalled();
  });

  it("replays accepted activation and rollback commands before checking a subsequently changed Harness baseline", async () => {
    const fixture = await bindingFixture();
    await activateMemoryPolicy(fixture.input);
    fixture.input.repository.getLatestSnapshot = vi.fn(async () => ({ ...snapshot(), componentSetHash: "newly-captured-set" }));
    expect((await activateMemoryPolicy(fixture.input)).replayed).toBe(true);
    await expect(activateMemoryPolicy({ ...fixture.input, campaignId: "different-campaign" })).rejects.toThrow("commandId conflicts");
    const rollback = { ...fixture.input, expectedVersion: 8, commandId: "rollback-1" };
    await rollbackMemoryPolicy(rollback);
    expect((await rollbackMemoryPolicy(rollback)).replayed).toBe(true);
    expect(fixture.update).toHaveBeenCalledTimes(2);
  });
});
