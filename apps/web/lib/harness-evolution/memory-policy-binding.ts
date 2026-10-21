import { readWorkingMemoryPolicyBinding, resolveWorkingMemoryStrategy } from "@/lib/workshops/working-memory-strategy";
import type { UpdateWorkCommand } from "@/lib/work-runtime/types";
import { canonicalJson } from "./canonical-json";
import { assertBoundedMemoryStrategyChange } from "./memory-evolution";
import { harnessEvolutionRepository, type HarnessEvolutionRepository } from "./repository";

type Identity = { version: string; hash: string };
type Baseline = { workshop: { id: string; userId: string; status: string; modelConfig: Record<string, unknown> | null }; commandVersion: number };

export interface MemoryPolicyBindingDependencies {
  baseline(userId: string, workshopId: string): Promise<Baseline | null>;
  update(command: UpdateWorkCommand): Promise<unknown>;
  receipt?(userId: string, commandId: string): Promise<{ workId: string; type: string; status: string; command: UpdateWorkCommand } | null>;
}

const defaultDependencies: MemoryPolicyBindingDependencies = {
  async baseline(userId, workshopId) {
    return (await import("@/lib/workshops/service")).getWorkshopConfigurationBaseline(userId, workshopId);
  },
  async update(command) { return (await import("@/lib/work-runtime/commands")).updateWork(command); },
  async receipt(userId, commandId) {
    const { getWorkCommand } = await import("@/lib/work-runtime/command-ledger");
    const { decodeCommandResult } = await import("@/lib/work-runtime/database-command");
    const receipt = await getWorkCommand(userId, commandId);
    return receipt ? { workId: receipt.workId, type: receipt.type, status: receipt.status, command: decodeCommandResult<UpdateWorkCommand>(receipt.payload) } : null;
  },
};

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function readActiveMemoryPolicyBinding(value: unknown, workshopId: string, identity: Identity) {
  return readWorkingMemoryPolicyBinding(value, workshopId, identity);
}

function assertOwnerCommand(input: { principal: { kind: "owner"; userId: string }; workshopId: string; commandId: string; expectedVersion: number }) {
  if (input.principal.kind !== "owner" || !input.principal.userId.trim()) throw new Error("An authenticated owner principal is required.");
  if (!input.commandId.trim() || input.commandId.length > 256 || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) throw new Error("Memory policy commands require a commandId and expectedVersion.");
}

/** Call only from an owner-authenticated application boundary. Agents remain proposal-only. */
export async function activateMemoryPolicy(input: {
  principal: { kind: "owner"; userId: string };
  workshopId: string;
  proposalId: string;
  campaignId: string;
  commandId: string;
  expectedVersion: number;
  repository?: HarnessEvolutionRepository;
  dependencies?: MemoryPolicyBindingDependencies;
}) {
  assertOwnerCommand(input);
  const repository = input.repository ?? harnessEvolutionRepository;
  const dependencies = input.dependencies ?? defaultDependencies;
  const baseline = await dependencies.baseline(input.principal.userId, input.workshopId);
  if (!baseline || baseline.workshop.userId !== input.principal.userId || baseline.workshop.id !== input.workshopId) throw new Error("Memory policy owner or work scope differs.");
  const previousCommand = await dependencies.receipt?.(input.principal.userId, input.commandId);
  if (previousCommand) {
    const savedBinding = object(previousCommand.command.patch.modelConfig?.memoryPolicyBinding);
    if (previousCommand.workId !== input.workshopId || previousCommand.type !== "updateWork" || previousCommand.command.source !== "owner" ||
      previousCommand.command.expectedVersion !== input.expectedVersion || savedBinding.proposalId !== input.proposalId || savedBinding.campaignId !== input.campaignId) throw new Error("Memory policy commandId conflicts with a previous command.");
    if (previousCommand.status !== "succeeded") throw new Error("The previous memory policy command requires command-ledger recovery.");
    const loaded = resolveWorkingMemoryStrategy(object(baseline.workshop.modelConfig).memoryUsageContract);
    if (loaded.issues.length || loaded.identity.hash !== savedBinding.hash || !readActiveMemoryPolicyBinding(object(baseline.workshop.modelConfig).memoryPolicyBinding, input.workshopId, loaded.identity).valid) throw new Error("The succeeded memory policy command is no longer loaded.");
    return { status: "loaded" as const, identity: loaded.identity, commandId: input.commandId, replayed: true };
  }
  const [proposal, campaign] = await Promise.all([
    repository.getProposal(input.workshopId, input.proposalId),
    repository.getEvaluationCampaign(input.workshopId, input.campaignId),
  ]);
  if (!proposal || proposal.status !== "confirmed" || proposal.workId !== input.workshopId || proposal.scope !== "work" ||
    proposal.affectedWorkIds.length !== 1 || proposal.affectedWorkIds[0] !== input.workshopId) throw new Error("A confirmed local memory proposal is required.");
  if (!campaign || campaign.status !== "passed" || campaign.changeProposalId !== proposal.id ||
    campaign.baselineHarnessSnapshotId !== proposal.baseHarnessSnapshotId) throw new Error("A passed matched memory evaluation campaign is required.");
  const evaluation = object(campaign.summary.evaluation);
  const usage = object(campaign.summary.usage);
  const holdoutIds = Array.isArray(campaign.summary.holdoutScenarioIds) ? campaign.summary.holdoutScenarioIds.filter((value): value is string => typeof value === "string") : [];
  if (campaign.summary.evaluatorKind !== "isolated-memory-model/v1" || evaluation.status !== "passed" ||
    !Array.isArray(evaluation.hardInvariantFailures) || evaluation.hardInvariantFailures.length > 0 ||
    usage.unknownRunCount !== 0 || usage.estimated !== false || holdoutIds.length === 0) throw new Error("Real model evaluation, complete actual usage and independent holdout confirmation are required.");
  const [baseSnapshot, candidateSnapshot, runs, currentSnapshot] = await Promise.all([
    repository.getResolvedSnapshot(input.workshopId, proposal.baseHarnessSnapshotId),
    repository.getResolvedSnapshot(input.workshopId, campaign.candidateHarnessSnapshotId),
    repository.listEvaluationRuns(campaign.id), repository.getLatestSnapshot(input.workshopId, "active"),
  ]);
  if (!baseSnapshot || !candidateSnapshot || candidateSnapshot.status !== "candidate" ||
    !currentSnapshot || currentSnapshot.componentSetHash !== proposal.baseComponentSetHash ||
    currentSnapshot.workVersionId !== proposal.baseWorkVersionId) throw new Error("Memory proposal baseline is stale or its candidate is unavailable.");
  if (runs.length === 0 || runs.some((run) => run.status !== "success" || !run.evidenceBundleId) ||
    holdoutIds.some((id) => !["baseline", "candidate"].every((cohort) => runs.some((run) => run.scenarioId === id && run.cohort === cohort)))) throw new Error("Persisted matched/holdout execution receipts are incomplete.");
  const before = baseSnapshot.components.find((component) => component.key === "work.context-policy");
  const after = candidateSnapshot.components.find((component) => component.key === "work.context-policy");
  if (!before || !after || proposal.changes.length !== 1 || proposal.changes[0].componentId !== before.componentId ||
    proposal.changes[0].componentType !== "context_policy" || Object.keys(proposal.changes[0].patch).some((key) => key !== "memoryUsageContract")) throw new Error("Only the bounded memory strategy can be activated.");
  // Recheck every other component and every protected context field against the immutable baseline.
  if (canonicalJson(baseSnapshot.policySummary) !== canonicalJson(candidateSnapshot.policySummary) ||
    canonicalJson(baseSnapshot.modelRuntime) !== canonicalJson(candidateSnapshot.modelRuntime) ||
    baseSnapshot.components.length !== candidateSnapshot.components.length || baseSnapshot.components.some((component) => {
      const candidate = candidateSnapshot.components.find((item) => item.key === component.key);
      if (!candidate) return true;
      const protectedMetadata = (item: typeof component) => ({ type: item.type, scope: item.scope, owner: item.owner,
        mutability: item.mutability, riskLevel: item.riskLevel, sourceKind: item.sourceKind, sourceRef: item.sourceRef });
      if (canonicalJson(protectedMetadata(component)) !== canonicalJson(protectedMetadata(candidate))) return true;
      if (component.key !== "work.context-policy") return canonicalJson(component.content) !== canonicalJson(candidate.content);
      const { memoryUsageContract: _before, ...protectedBefore } = component.content;
      const { memoryUsageContract: _after, ...protectedAfter } = candidate.content;
      return canonicalJson(protectedBefore) !== canonicalJson(protectedAfter);
    })) throw new Error("A protected Harness component changed.");
  const candidate = assertBoundedMemoryStrategyChange(before.content.memoryUsageContract, after.content.memoryUsageContract);
  const modelConfig = object(baseline.workshop.modelConfig);
  const existingBinding = object(modelConfig.memoryPolicyBinding);
  if (existingBinding.commandId === input.commandId && existingBinding.proposalId === proposal.id && existingBinding.campaignId === campaign.id) {
    const readback = readActiveMemoryPolicyBinding(existingBinding, input.workshopId, candidate.identity);
    if (!readback.valid) throw new Error("Replayed memory binding does not match the loaded policy.");
    return { status: "loaded" as const, identity: candidate.identity, commandId: input.commandId, replayed: true };
  }
  const current = resolveWorkingMemoryStrategy(modelConfig.memoryUsageContract);
  const previous = resolveWorkingMemoryStrategy(before.content.memoryUsageContract);
  if (current.issues.length || current.identity.hash !== previous.identity.hash || baseline.commandVersion !== input.expectedVersion) throw new Error("The loaded memory policy or command version changed concurrently.");
  const binding = {
    schemaVersion: "memory-policy-binding.v1", status: "active", workshopId: input.workshopId,
    ...candidate.identity, proposalId: proposal.id, campaignId: campaign.id, commandId: input.commandId,
    appliedBy: input.principal.userId, appliedAt: new Date().toISOString(),
    previous: { contract: modelConfig.memoryUsageContract ?? null, binding: modelConfig.memoryPolicyBinding ?? null, identity: previous.identity },
  };
  await dependencies.update({ userId: input.principal.userId, workId: input.workshopId, commandId: input.commandId,
    expectedVersion: input.expectedVersion, source: "owner", reason: `Activate evaluated memory policy ${candidate.identity.version}; proposal ${proposal.id}; campaign ${campaign.id}`,
    patch: { modelConfig: { ...modelConfig, memoryUsageContract: candidate.strategy, memoryPolicyBinding: binding } },
  });
  const readback = await dependencies.baseline(input.principal.userId, input.workshopId);
  const loadedConfig = object(readback?.workshop.modelConfig);
  const loaded = resolveWorkingMemoryStrategy(loadedConfig.memoryUsageContract);
  if (!readback || readback.workshop.status !== baseline.workshop.status || loaded.issues.length ||
    loaded.identity.hash !== candidate.identity.hash || !readActiveMemoryPolicyBinding(loadedConfig.memoryPolicyBinding, input.workshopId, candidate.identity).valid) {
    throw new Error("Memory policy saved but loaded readback failed; inspect the command receipt and recover explicitly.");
  }
  return { status: "loaded" as const, identity: loaded.identity, commandId: input.commandId, replayed: false };
}

export async function rollbackMemoryPolicy(input: {
  principal: { kind: "owner"; userId: string }; workshopId: string;
  proposalId: string; commandId: string; expectedVersion: number;
  dependencies?: MemoryPolicyBindingDependencies;
}) {
  assertOwnerCommand(input);
  const dependencies = input.dependencies ?? defaultDependencies;
  const baseline = await dependencies.baseline(input.principal.userId, input.workshopId);
  if (!baseline || baseline.workshop.userId !== input.principal.userId) throw new Error("Memory rollback owner or version differs.");
  const previousCommand = await dependencies.receipt?.(input.principal.userId, input.commandId);
  if (previousCommand) {
    if (previousCommand.workId !== input.workshopId || previousCommand.type !== "updateWork" || previousCommand.command.source !== "owner" ||
      previousCommand.command.expectedVersion !== input.expectedVersion || !previousCommand.command.reason?.endsWith(`failed proposal ${input.proposalId}`)) throw new Error("Memory rollback commandId conflicts with a previous command.");
    if (previousCommand.status !== "succeeded") throw new Error("The previous memory rollback command requires command-ledger recovery.");
    const restored = resolveWorkingMemoryStrategy(previousCommand.command.patch.modelConfig?.memoryUsageContract);
    const loaded = resolveWorkingMemoryStrategy(object(baseline.workshop.modelConfig).memoryUsageContract);
    if (restored.issues.length || loaded.issues.length || restored.identity.hash !== loaded.identity.hash) throw new Error("The succeeded rollback policy is no longer loaded.");
    return { status: "loaded" as const, identity: loaded.identity, commandId: input.commandId, previousPolicyHash: null, replayed: true };
  }
  if (baseline.commandVersion !== input.expectedVersion) throw new Error("Memory rollback owner or version differs.");
  const config = object(baseline.workshop.modelConfig);
  const current = resolveWorkingMemoryStrategy(config.memoryUsageContract);
  const binding = object(config.memoryPolicyBinding);
  if (current.issues.length || !readActiveMemoryPolicyBinding(binding, input.workshopId, current.identity).valid ||
    binding.proposalId !== input.proposalId) throw new Error("The active memory policy does not belong to this proposal.");
  const previous = object(binding.previous);
  if (!Object.hasOwn(previous, "contract") || !Object.hasOwn(previous, "binding")) throw new Error("The memory rollback baseline is missing.");
  const restored = resolveWorkingMemoryStrategy(previous.contract);
  if (restored.issues.length || canonicalJson(restored.identity) !== canonicalJson(previous.identity)) throw new Error("The saved memory rollback identity is invalid.");
  if (!readActiveMemoryPolicyBinding(previous.binding, input.workshopId, restored.identity).valid) throw new Error("The saved memory rollback binding is invalid.");
  const nextConfig = { ...config };
  if (previous.contract === null) delete nextConfig.memoryUsageContract;
  else nextConfig.memoryUsageContract = previous.contract;
  if (previous.binding === null) delete nextConfig.memoryPolicyBinding;
  else nextConfig.memoryPolicyBinding = previous.binding;
  await dependencies.update({ userId: input.principal.userId, workId: input.workshopId, commandId: input.commandId,
    expectedVersion: input.expectedVersion, source: "owner", reason: `Restore memory policy ${restored.identity.version}; failed proposal ${input.proposalId}`,
    patch: { modelConfig: nextConfig },
  });
  const readback = await dependencies.baseline(input.principal.userId, input.workshopId);
  const loaded = resolveWorkingMemoryStrategy(object(readback?.workshop.modelConfig).memoryUsageContract);
  if (!readback || loaded.issues.length || loaded.identity.hash !== restored.identity.hash || readback.workshop.status !== baseline.workshop.status) throw new Error("Memory rollback saved but loaded readback failed.");
  return { status: "loaded" as const, identity: loaded.identity, commandId: input.commandId, previousPolicyHash: current.identity.hash };
}
