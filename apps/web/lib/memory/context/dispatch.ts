import { AsyncLocalStorage } from "node:async_hooks";
import { withDatabaseTransaction } from "@/lib/db/client";
import { MemoryModuleError } from "../kernel/errors";
import { finalizeContextPack, type FinalizeContextPackInput } from "./finalize";
import type { BrainContextPackItem } from "./pack";
import { admitExactUse, exactProofKey, exactProofVersions, revalidateExactUse, prepareExactUseRevalidation, type ExactUseProof } from "./exact-use-admission";
import { withMemoryModelSourceScope } from './model-source-scope';

type Group = { input: FinalizeContextPackInput; items: Map<string, BrainContextPackItem> };
type DispatchContext = {
  active: boolean;
  groups: Map<string, Group>;
  exact: Map<string, ExactUseProof>;
  versions: Map<string, string>;
  generation: number;
  sequence: number;
  proofCount: number;
  failure?: MemoryModuleError;
  admission?: Promise<void>;
  providerHookSupported?: boolean;
};
const contexts = new AsyncLocalStorage<DispatchContext>();
const MAX_REFS = 256;
const MAX_POLICIES = 64;

function unavailable(): MemoryModuleError {
  return new MemoryModuleError("memory_dispatch_context_unavailable", 503,
    "Memory context changed or could not be verified before model dispatch; start a fresh context");
}
function fail(context: DispatchContext): never {
  context.failure ??= unavailable();
  throw context.failure;
}
function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([, child]) => child !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => [key, ordered(child)]));
  return value;
}

/** The scope covers initial recall, model turns and tools. Detached continuations
 * cannot use it after work finishes. Nested host helpers retain the same proofs. */
export async function withMemoryDispatchContext<T>(work: () => Promise<T>): Promise<T> {
  const current = contexts.getStore();
  if (current) {
    if (!current.active || current.failure) fail(current);
    return work();
  }
  const context: DispatchContext = { active: true, groups: new Map(), exact: new Map(), versions: new Map(), generation: 0, sequence: 0, proofCount: 0 };
  return withMemoryModelSourceScope(() => contexts.run(context, async () => {
    try { return await work(); }
    finally { context.active = false; context.groups.clear(); context.exact.clear(); context.versions.clear(); }
  }));
}

/** A host must bind the actual selected runtime before starting it. An adapter
 * without a per-request hook may run only while no canonical memory has entered
 * the transcript; later tool recall fails before returning its selected body. */
export function bindMemoryDispatchRuntime(runtime: { engine: string; adapter: string }): void {
  const context = contexts.getStore();
  if (!context) return;
  if (!context.active || context.failure) fail(context);
  const supported = runtime.engine === "pi" && (runtime.adapter === "pi-agent-harness" || runtime.adapter === "pi-agent-core")
    || runtime.engine === "claude" && runtime.adapter === "claude-sdk-controlled-http";
  context.providerHookSupported = context.providerHookSupported !== false && supported;
  if (!context.providerHookSupported && context.versions.size) fail(context);
}

/** Exact tools use the existing model-run scope. Unsupported and detached
 * runtimes must fail before a newly read body becomes a tool result. */
export function exactUseRegistrationRequired(): boolean {
  const context = contexts.getStore();
  if (!context) return false;
  if (!context.active || context.failure || context.providerHookSupported === false) fail(context);
  return true;
}
/** Auxiliary model calls cannot assume that the provider selected later by the
 * host will support dispatch admission. They may run only after actual binding. */
export function isMemoryDispatchRuntimeSupported(): boolean {
  const context = contexts.getStore();
  if (!context) return false;
  if (!context.active || context.failure) fail(context);
  return context.providerHookSupported === true;
}

export function registerExactUseForDispatch(proof: ExactUseProof): void {
  const context = contexts.getStore();
  if (!context) return;
  if (!context.active || context.failure || context.providerHookSupported === false) fail(context);
  const key = exactProofKey(proof);
  if (context.exact.has(key)) return;
  const versions = exactProofVersions(proof);
  if (context.exact.size + context.groups.size >= MAX_POLICIES || context.proofCount + versions.length > MAX_REFS) fail(context);
  for (const { identity, version } of versions) {
    const prior = context.versions.get(identity);
    if (!version || prior && prior !== version || !prior && context.versions.size >= MAX_REFS) fail(context);
    context.versions.set(identity, version);
  }
  context.exact.set(key, proof);
  context.proofCount += versions.length;
  context.generation++;
}

/** Register only the actual finalized selection. Newer recall never erases an
 * older version that may remain in the model transcript. Ordinary owner reads
 * outside a model run do not create an implicit dispatch scope. */
export function registerContextForDispatch(input: FinalizeContextPackInput): void {
  const context = contexts.getStore();
  if (!context) return;
  if (!context.active || context.failure) fail(context);
  if (!input.pack.items.length) return;
  if (context.providerHookSupported === false) fail(context);
  const policy = structuredClone({ requester: input.requester, accessMode: input.accessMode,
    sourceFilters: input.sourceFilters, includeCandidates: input.includeCandidates,
    applicabilityMode: input.applicabilityMode ?? input.pack.applicabilityMode, recallProfiles: input.recallProfiles });
  const key = JSON.stringify(ordered(policy));
  let group = context.groups.get(key);
  if (!group) {
    if (context.groups.size + context.exact.size >= MAX_POLICIES) fail(context);
    group = { input: { ...policy, taskIntent: input.taskIntent,
      pack: { interfaceVersion: "brain-context.v1", applicabilityMode: policy.applicabilityMode,
        contextLogId: input.pack.contextLogId, items: [], denied: [], omitted: [], warnings: [],
        selection: { selectedCount: 0, deniedCount: 0, omittedCount: 0, duplicateCanonicalGroupCount: 0, selectedCanonicalKinds: {} } } },
      items: new Map() };
    context.groups.set(key, group);
  }
  for (const original of input.pack.items) {
    const version = original.revisionVersion;
    if (!version) fail(context);
    const identity = `${input.requester.userId}:${original.id}`;
    const priorVersion = context.versions.get(identity);
    if (priorVersion && priorVersion !== version) fail(context);
    if (!priorVersion && context.versions.size >= MAX_REFS) fail(context);
    context.versions.set(identity, version);
    if (!group.items.has(original.id)) {
      if (context.proofCount >= MAX_REFS) fail(context);
      context.proofCount++;
      // bmrv1 covers the complete stored row. Rechecking that exact token does
      // not need another copy of private transcript bodies or source metadata.
      // Empty content is a legal prefix; this projection is never a replacement
      // model context and is used only for the final admission audit.
      group.items.set(original.id, { id: original.id, revisionVersion: version,
        ownerType: original.ownerType, ownerId: original.ownerId, memoryType: original.memoryType,
        subject: original.subject, content: "", evidenceRefs: [], score: 0, reasons: ["dispatch_reference_only"] });
    }
  }
  context.generation++;
}

/** Last host admission before a logical provider request. All versions and
 * authority share locks survive until all admission audits commit. The callback
 * cannot recall, replace transcript bodies or grant action permissions. Once it
 * returns the request is in flight; transport retries belong to that admission. */
export async function assertMemoryDispatchCurrent(): Promise<void> {
  const context = contexts.getStore();
  if (!context) throw unavailable();
  if (!context.active || context.failure) fail(context);
  if (context.providerHookSupported === undefined) fail(context);
  if (context.admission) { await context.admission; return assertMemoryDispatchCurrent(); }
  if (!context.groups.size && !context.exact.size) return;
  const generation = context.generation, sequence = ++context.sequence;
  const admit = async () => {
    const physical = new Map<ExactUseProof, Awaited<ReturnType<typeof prepareExactUseRevalidation>>>();
    for (const proof of context.exact.values()) physical.set(proof, await prepareExactUseRevalidation(proof));
    const receipts = await withDatabaseTransaction(async () => {
      const results: Array<{ group: Group; contextLogId: string | undefined }> = [];
      for (const group of context.groups.values()) {
        const items = [...group.items.values()];
        const pack = await finalizeContextPack({ ...group.input,
          pack: { ...group.input.pack, items },
          // Always use the dispatch clock, never the recall's test/input clock.
          now: undefined,
          metadata: { source: "memory_provider_dispatch_admission", dispatch: {
            schemaVersion: "memory-dispatch.v1", sequence, boundary: "logical_request_admission",
          } } });
        const actual = new Map(pack.items.map(item => [item.id, item.revisionVersion]));
        if (!pack.contextLogId || actual.size !== items.length
          || items.some(item => actual.get(item.id) !== item.revisionVersion)) fail(context);
        results.push({ group, contextLogId: pack.contextLogId });
      }
      // These proofs were issued from actual exact-source reads, independently
      // of recall. All later requests recheck their original immutable versions.
      for (const proof of context.exact.values()) await revalidateExactUse(proof, sequence, physical.get(proof));
      if (!context.active || context.generation !== generation || context.failure) fail(context);
      return results;
    });
    for (const receipt of receipts) receipt.group.input.pack.contextLogId = receipt.contextLogId;
  };
  const pending = admit().catch(() => fail(context));
  context.admission = pending;
  try { await pending; }
  finally { if (context.admission === pending) context.admission = undefined; }
}

/** Preserve the selected versions, not the rendered prompt as a claimed source.
 * This can run only in the generating request's real, still active scope. */
export async function captureMemoryDispatchSources(userId: string): Promise<{ receiptIds: string[]; signature: string }> {
  const context = contexts.getStore(); if (!context || !context.active || context.failure) throw unavailable();
  const generation = context.generation;
  const proofs = [...context.exact.values()];
  for (const proof of proofs) if (proof.policy.requester.type !== "chat" || proof.policy.requester.userId !== userId
    || proof.refs.some(ref => ref.kind === "plan" || ref.kind === "file-binding")) fail(context);
  for (const group of context.groups.values()) {
    if (group.input.requester.type !== "chat" || group.input.requester.userId !== userId) fail(context);
    proofs.push(await admitExactUse({ requester: group.input.requester, accessMode: group.input.accessMode,
      sourceFilters: group.input.sourceFilters, purpose: "plan_captured_recall",
      memoryRefs: [...group.items.values()].map(item => ({ id: item.id, revision: item.revisionVersion! })) }));
  }
  if (proofs.length > MAX_POLICIES - 2 || context.proofCount > MAX_REFS - 2
    || !context.active || context.generation !== generation || context.failure) fail(context);
  return { receiptIds: [...new Set(proofs.map(proof => proof.receiptId))],
    signature: JSON.stringify(proofs.map(exactProofKey).sort()) };
}
