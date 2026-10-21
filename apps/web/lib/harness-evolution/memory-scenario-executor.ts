import { createHash } from "node:crypto";
import { sha256Canonical } from "./canonical-json";
import { resolveWorkingMemoryStrategy } from "@/lib/workshops/working-memory-strategy";
import type { HarnessEvaluationExecutionRequest, HarnessEvaluationExecutionResult } from "./types";

export const MEMORY_MODEL_EVALUATOR = "isolated-memory-model/v1" as const;

export interface FrozenMemorySource {
  id: string;
  content: string;
  contentHash: string;
  observedAt: string;
  provider: string;
  warning: string | null;
}

export interface MemoryScenarioRuntime {
  model: string;
  provider: string;
  sourceSnapshotHash: string;
  toolContractHash: string;
  allowedTools: string[];
  deniedTools: string[];
  budget: { maxModelCalls: number; maxTotalTokens: number; maxDurationMs: number };
}

export interface MemoryModelScenarioTrace {
  runId: string;
  status: "success" | "failed" | "blocked" | "timeout";
  output: string;
  actualRuntimeHash: string;
  loadedPolicyHash: string;
  providerRequests: Array<{ requestId: string; payloadHash: string; model: string }>;
  usage: null | {
    source: "provider" | "sdk";
    completeness: "complete" | "partial";
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cacheReadTokens?: number;
  };
  durationMs: number;
  actions: string[];
  memoryOperations: Array<{ operation: string; eventId: string; policyHash: string }>;
  sourceRefs: string[];
  warnings: string[];
}

export interface MemoryScenarioReceipt {
  interfaceVersion: "memory-scenario-receipt.v1";
  evaluatorKind: typeof MEMORY_MODEL_EVALUATOR;
  scenarioKey: string;
  cohort: "baseline" | "candidate";
  repetition: number;
  runId: string;
  runtimeHash: string;
  policyHash: string;
  providerRequests: MemoryModelScenarioTrace["providerRequests"];
  usage: MemoryModelScenarioTrace["usage"];
  usageStatus: "reported" | "unknown";
  memoryOperations: MemoryModelScenarioTrace["memoryOperations"];
  sourceRefs: string[];
  outputHash: string;
  independentVerification: { verifierId: string; passed: boolean; failures: string[] };
  durationMs: number;
  warnings: string[];
}

export function hashFrozenMemorySource(content: string) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

const forbiddenActions = new Set(["external_send", "external_write", "real_funds", "payment", "delete", "permission_change", "grant_change"]);

/** The runner is an injected Pi adapter with frozen read tools, never the fixture scorer. */
export function createIsolatedMemoryScenarioExecutor(input: {
  runtime: MemoryScenarioRuntime;
  policies: { baseline: Record<string, unknown>; candidate: Record<string, unknown> };
  loadSources(scenarioKey: string): Promise<FrozenMemorySource[]>;
  runner: {
    kind: "pi-harness";
    execute(request: {
      scenario: HarnessEvaluationExecutionRequest["scenario"];
      repetition: number;
      runtime: MemoryScenarioRuntime;
      runtimeHash: string;
      policy: Record<string, unknown>;
      policyHash: string;
      sources: FrozenMemorySource[];
      allowExternalActions: false;
      signal?: AbortSignal;
    }): Promise<MemoryModelScenarioTrace>;
  };
  verifier: {
    id: string;
    verify(request: {
      scenario: HarnessEvaluationExecutionRequest["scenario"];
      trace: MemoryModelScenarioTrace;
      sources: FrozenMemorySource[];
    }): Promise<{ passed: boolean; failures: string[]; metrics: Record<string, number> }>;
  };
  persistReceipt(receipt: MemoryScenarioReceipt): Promise<{ evidenceBundleId: string }>;
}) {
  if (!input.verifier.id.trim()) throw new Error("An independent verifier identity is required.");
  const runtime = structuredClone(input.runtime);
  for (const value of Object.values(runtime.budget)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Memory scenario budgets must be positive integers.");
  }
  const deniedTools = new Set(runtime.deniedTools);
  runtime.allowedTools = runtime.allowedTools.filter((tool) => !deniedTools.has(tool) && !deniedTools.has("*"));
  const runtimeHash = sha256Canonical(runtime);
  const policies = structuredClone(input.policies);
  const execute = async (request: HarnessEvaluationExecutionRequest): Promise<HarnessEvaluationExecutionResult> => {
    if (request.allowExternalActions !== false || request.allowRealFunds !== false || request.allowDestructiveActions !== false) {
      throw new Error("Memory evaluation isolation cannot be disabled.");
    }
    if (request.runtimeContract.memoryRuntimeHash !== runtimeHash) throw new Error("Frozen memory runtime contract differs.");
    request.signal?.throwIfAborted();
    const sources = structuredClone(await input.loadSources(request.scenario.scenarioKey));
    if (sources.length === 0 || sources.some((source) => source.contentHash !== hashFrozenMemorySource(source.content))) {
      throw new Error("Frozen memory source content is missing or has changed.");
    }
    if (sha256Canonical(sources.map(({ content: _content, ...metadata }) => metadata)) !== runtime.sourceSnapshotHash) {
      throw new Error("Frozen source snapshot identity differs.");
    }
    const policy = policies[request.cohort];
    const resolvedPolicy = resolveWorkingMemoryStrategy(policy);
    if (resolvedPolicy.issues.length) throw new Error("Memory scenario strategy is invalid.");
    const policyHash = resolvedPolicy.identity.hash;
    const trace = await input.runner.execute({
      scenario: request.scenario, repetition: request.repetition,
      runtime: structuredClone(runtime), runtimeHash,
      policy: structuredClone(policy), policyHash, sources: structuredClone(sources),
      allowExternalActions: false, signal: request.signal,
    });
    request.signal?.throwIfAborted();
    const failures: string[] = [];
    if (trace.actualRuntimeHash !== runtimeHash) failures.push("runtime_contract_changed");
    if (trace.loadedPolicyHash !== policyHash) failures.push("memory_policy_not_loaded");
    if (trace.providerRequests.length === 0) failures.push("actual_provider_request_missing");
    if (trace.providerRequests.some((receipt) => !receipt.requestId || !receipt.payloadHash || receipt.model !== runtime.model)) failures.push("provider_request_identity_invalid");
    if (trace.memoryOperations.some((operation) => operation.policyHash !== policyHash || !operation.eventId)) failures.push("memory_operation_identity_invalid");
    if (trace.sourceRefs.some((id) => !sources.some((source) => source.id === id))) failures.push("source_reference_outside_snapshot");
    for (const action of trace.actions) {
      if (forbiddenActions.has(action) || runtime.deniedTools.includes(action) || runtime.deniedTools.includes("*")) failures.push(`forbidden_action:${action}`);
      if (!runtime.allowedTools.includes(action)) failures.push(`tool_outside_frozen_contract:${action}`);
    }
    if (trace.providerRequests.length > runtime.budget.maxModelCalls) failures.push("model_call_budget_exceeded");
    if (!Number.isFinite(trace.durationMs) || trace.durationMs < 0 || trace.durationMs > runtime.budget.maxDurationMs) failures.push("duration_budget_exceeded");
    const usageValid = trace.usage !== null && trace.usage.completeness === "complete" &&
      [trace.usage.inputTokens, trace.usage.outputTokens, trace.usage.totalTokens].every((value) => Number.isSafeInteger(value) && value >= 0);
    const usageStatus = usageValid ? "reported" as const : "unknown" as const;
    if (usageValid && trace.usage!.totalTokens > runtime.budget.maxTotalTokens) failures.push("token_budget_exceeded");
    const verification = await input.verifier.verify({ scenario: request.scenario, trace, sources });
    failures.push(...verification.failures);
    if (!verification.passed && verification.failures.length === 0) failures.push("independent_verification_failed");
    const warnings = [...trace.warnings, ...sources.flatMap((source) => source.warning ? [source.warning] : [])];
    if (usageStatus === "unknown") warnings.push("Actual provider usage is unknown or partial; no token estimate was substituted.");
    const receipt: MemoryScenarioReceipt = {
      interfaceVersion: "memory-scenario-receipt.v1", evaluatorKind: MEMORY_MODEL_EVALUATOR,
      scenarioKey: request.scenario.scenarioKey, cohort: request.cohort, repetition: request.repetition,
      runId: trace.runId, runtimeHash, policyHash, providerRequests: trace.providerRequests,
      usage: trace.usage, usageStatus, memoryOperations: trace.memoryOperations,
      sourceRefs: trace.sourceRefs, outputHash: hashFrozenMemorySource(trace.output), durationMs: trace.durationMs,
      independentVerification: { verifierId: input.verifier.id, passed: verification.passed, failures: verification.failures },
      warnings,
    };
    // A failed audit aborts this run instead of returning an untraceable score.
    const persisted = await input.persistReceipt(receipt);
    if (!persisted.evidenceBundleId) throw new Error("Memory evaluation receipt was not persisted.");
    const metrics = Object.fromEntries(Object.entries(verification.metrics).filter(([, value]) => Number.isFinite(value)));
    // Harness metrics have a higher-is-better contract; positive raw cost stays in the receipt.
    if (usageValid) metrics.tokenCostScore = -trace.usage!.totalTokens;
    return {
      status: failures.length > 0 ? "failed" : trace.status, metrics, actions: trace.actions,
      hardInvariantFailures: [...new Set(failures)], evidenceBundleId: persisted.evidenceBundleId,
      usageStatus, warnings,
    };
  };
  return { kind: MEMORY_MODEL_EVALUATOR, runtimeHash, execute };
}
