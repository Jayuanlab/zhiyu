import { admitExactUse, type ExactUseAdmission, type ExactUsePolicy } from "./exact-use-admission";
import { exactUseRegistrationRequired, registerExactUseForDispatch } from "./dispatch";
import type { BrainMemory } from "../kernel/memory-types";
import { MemoryModuleError } from "../kernel/errors";
import { AsyncLocalStorage } from "node:async_hooks";
import { PLATFORM_SOURCE_DEFINITIONS } from "../sources/catalog";

const readerPolicies = new AsyncLocalStorage<ExactUsePolicy>();
/** Trusted host capability, independent of tool/model arguments. */
export function withExactUseReaderPolicy<T>(policy: ExactUsePolicy, work: () => Promise<T>): Promise<T> {
  return readerPolicies.run(structuredClone(policy), work);
}

export async function admitExactPublishedRecordUse(input: { userId: string; source: string; rows: Record<string, unknown>[] }) {
  if (!input.rows.length) return;
  const policy = readerPolicies.getStore() ?? { requester: { type: "chat" as const, userId: input.userId },
    accessMode: "owner_override" as const, purpose: "owner_published_exact_source" };
  if (!["brainMemories", "brainObservations", "brainStateSnapshots"].includes(input.source)) {
    const definition = PLATFORM_SOURCE_DEFINITIONS.find(item => item[0] === input.source);
    if (!definition || policy.requester.userId !== input.userId) throw new MemoryModuleError("memory_source_unregistered", 403, "This source has no verified model reader");
    if (!exactUseRegistrationRequired()) return;
    registerExactUseForDispatch(await admitExactUse({ ...policy, sources: input.rows.map(projection => ({ source: definition[0], id: String(projection[definition[2]]), projection })) }));
    return;
  }
  // This existing gateway has only an owner projection. A Work capability must
  // use the scoped canonical/observation/snapshot readers instead.
  if (policy.requester.userId !== input.userId || policy.requester.type !== "chat") {
    throw new MemoryModuleError("memory_exact_use_unavailable", 503, "Published owner source is unavailable in this Work scope");
  }
  if (!exactUseRegistrationRequired()) return;
  const source = input.source as NonNullable<ExactUseAdmission["publishedRecords"]>[number]["source"];
  const publishedRecords = input.rows.map(fields => ({ source, id: String(fields.id), fields }));
  registerExactUseForDispatch(await admitExactUse({ ...policy, publishedRecords }));
}

export function currentExactUseReaderPolicy(): ExactUsePolicy | undefined {
  const policy = readerPolicies.getStore();
  return policy ? structuredClone(policy) : undefined;
}

/** Actual model runs must register independently read canonical sources before
 * their body is returned. An ordinary owner/UI read does not create a model run. */
export async function admitExactMemoryUse(input: ExactUsePolicy & { memories: BrainMemory[] }) {
  if (!input.memories.length || !exactUseRegistrationRequired()) return;
  registerExactUseForDispatch(await admitExactUse(input));
}
export async function admitExactObservationUse(input: ExactUsePolicy & { observations: NonNullable<ExactUseAdmission["observations"]> }) {
  if (!input.observations.length || !exactUseRegistrationRequired()) return;
  registerExactUseForDispatch(await admitExactUse(input));
}
export async function admitExactSnapshotUse(input: ExactUsePolicy & { snapshots: NonNullable<ExactUseAdmission["snapshots"]> }) {
  if (!input.snapshots.length || !exactUseRegistrationRequired()) return;
  registerExactUseForDispatch(await admitExactUse(input));
}
export async function admitExactArtifactUse(input: ExactUsePolicy & { artifacts: NonNullable<ExactUseAdmission["artifacts"]> }) {
  if (!input.artifacts.length || !exactUseRegistrationRequired()) return;
  registerExactUseForDispatch(await admitExactUse(input));
}
/** Reference verification for stored derivations; it does not verify the
 * derivation's prose or substitute a new source version for an old transcript. */
export async function verifyExactMemoryRefsForDispatch(input: ExactUsePolicy & { refs: Array<{ id: string; revision: string }> }) {
  if (!exactUseRegistrationRequired()) throw new MemoryModuleError("memory_exact_use_unavailable", 503, "A live model dispatch scope is required for source verification");
  if (!input.refs.length) return;
  registerExactUseForDispatch(await admitExactUse({ ...input, memoryRefs: input.refs }));
}
