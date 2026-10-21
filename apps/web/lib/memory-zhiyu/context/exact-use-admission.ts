import { MemoryModuleError } from "@/lib/memory/kernel/errors";
import { memoryRecallOmitReason } from "@/lib/memory/records/lifecycle";
import { canReadMemory } from "@/lib/memory/revision/policy";
import { getBrainMemoryRevisionVersion } from "@/lib/memory/revision/version";
import { withMemoryRecordWrite } from "@/lib/memory/revision/transaction";
import { sourceFilterOmitReason } from "@/lib/memory/kernel/source-filters";
import { getBrainMemoryCanonicalMetadata, matchBrainMemoryScenarioApplicability } from "@/lib/memory/kernel/memory-canonical";
import { readContextMemoriesForShare, readContextGrantsForShare } from "@/lib/memory/adapters/postgres/memory-records";
import { readObservation } from "@/lib/memory/adapters/postgres/observations";
import { observationVersion, stableJson } from "@/lib/memory/records/observations";
import { readStateSnapshotInTransaction } from "@/lib/memory/adapters/postgres/state-snapshots";
import { stateSnapshotRevisionVersion, type StateSnapshotRecord } from "@/lib/memory/records/state-snapshots";
import { lockContextOwnerForShare, insertContextLogInTransaction, readOwnedContextLogForShare } from "@/lib/memory/adapters/postgres/context-logs";
import { readPlanSourceForShare } from "@/lib/memory/adapters/postgres/plans";
import { db, withDatabaseTransaction } from "@/lib/db/client";
import { persistedExactSchema } from "@/lib/memory/context/persisted-exact-contracts";
import type { BrainMemory, BrainRequester, BrainSourceFilters } from "@/lib/memory/kernel/memory-types";
import { readExactPublishedRowsForShare, readExactWorkBindingForShare, readExactArtifactEvidenceReceiptForShare, type ExactPublishedSource } from "@/lib/memory/adapters/postgres/exact-published-sources";
import { resolveExecutionLease } from "@/lib/work-runtime/execution-context";
import { revalidateArtifactInTransaction } from "@/lib/memory/artifacts/service";
import { readSourceRecordForShare } from "@/lib/memory/adapters/postgres/source-records";
import type { MemorySourceKind } from "@/lib/memory/sources/catalog";
import { matchesSourceProjection } from "@/lib/memory/sources/records";
import { admitRagSourceProjectionInTransaction, revalidateRagSourceInTransaction } from "@/lib/memory/adapters/postgres/rag";
import { readFileBindingForShare, type FileReadAuthority } from '@/lib/memory/adapters/postgres/file-bindings';
import { prepareFilePhysical, assertPhysicalTicket, prepareArtifactPhysical, assertArtifactPhysicalTicket, type FilePhysicalTicket, type ArtifactPhysicalTicket } from '@/lib/memory/files/physical';
import type { FileBindingRef } from '@/lib/memory/files/contracts';

export type ExactUsePolicy = { requester: BrainRequester; accessMode?: "strict" | "owner_override";
  sourceFilters?: BrainSourceFilters; purpose: string;
  sourceCapability?: "wechatListRecordedMessages" | "interactionListWiki" | "ownerContextGetEvidence" | "ownerContextListCandidates" };
export type ExactMemoryRef = { kind: "memory"; id: string; revision: string };
export type ExactObservationRef = { kind: "observation"; id: string; revision: string; sourceMemoryId?: string; targetMemoryId?: string };
export type ExactSnapshotRef = { kind: "snapshot"; id: string; revision: string; workId?: string;
  snapshotTypes?: string[]; recordedBefore?: string };
export type ExactArtifactRef = { kind: "artifact"; id: string; revision: string; evidenceReceiptId: string; start: number; end: number };
export type ExactSourceRef = { kind: "source"; source: MemorySourceKind; id: string; revision: string; representation?: "file_source_descriptor.v1" };
export type ExactPlanRef = { kind: "plan"; id: string; revision: string };
export type ExactRef = ExactMemoryRef | ExactObservationRef | ExactSnapshotRef | ExactArtifactRef | ExactSourceRef | FileBindingRef | ExactPlanRef;
type PhysicalTicket = FilePhysicalTicket | ArtifactPhysicalTicket;
export type ExactUseProof = Readonly<{ policy: ExactUsePolicy; refs: readonly ExactRef[]; receiptId: string }>;
export type ExactUseAdmission = ExactUsePolicy & { memories?: BrainMemory[]; memoryRefs?: Array<{ id: string; revision: string }>;
  observations?: Array<{ id: string; content: string; sourceMemoryId: string; targetMemoryId: string }>;
  snapshots?: Array<{ record: StateSnapshotRecord; workId?: string; snapshotTypes?: string[]; recordedBefore?: string }>;
  publishedRecords?: Array<{ source: ExactPublishedSource; id: string; fields: Record<string, unknown> }>;
  artifacts?: Array<{ id: string; revision: string; evidenceReceiptId: string; start: number; end: number }>;
  fileBindings?: Array<FileBindingRef & { physicalTicket: FilePhysicalTicket }>;
  plans?: Array<{ id: string; revision: string }>;
  sources?: Array<{ source: MemorySourceKind; id: string; revision?: string; projection: unknown }> };

const issued = new WeakSet<object>();
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const unavailable = () => new MemoryModuleError("memory_exact_use_unavailable", 503,
  "Exact source changed or its access and audit could not be verified; read a fresh authorized source");
function policyFor(input: ExactUsePolicy): ExactUsePolicy {
  return structuredClone({ requester: input.requester, accessMode: input.accessMode, sourceFilters: input.sourceFilters, purpose: input.purpose, sourceCapability: input.sourceCapability });
}
function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}
function assertMemory(memory: BrainMemory, policy: ExactUsePolicy, grants: Parameters<typeof canReadMemory>[0]["grants"], now: Date) {
  if (memoryRecallOmitReason(memory)) throw unavailable();
  if (memory.status === "deleted" || !canReadMemory({ memory, requester: policy.requester, grants, accessMode: policy.accessMode, now }).allowed) throw unavailable();
  if (sourceFilterOmitReason(getBrainMemoryCanonicalMetadata(memory).facets, policy.sourceFilters)) throw unavailable();
  if (["work", "loop", "tool"].includes(policy.requester.type)) {
    const scenario = matchBrainMemoryScenarioApplicability(memory, { scenarioKeys: policy.sourceFilters?.scenarioKeys });
    if (scenario.applicability.status === "scoped" && !scenario.matched
      || policy.sourceFilters?.scenarioKeys?.length && scenario.applicability.status === "unknown") throw unavailable();
  }
}
function assertProof(proof: ExactUseProof) { if (!issued.has(proof)) throw unavailable(); }
function publishedValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(publishedValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, publishedValue(child)]));
  return value ?? null;
}
export function exactProofKey(proof: ExactUseProof): string {
  assertProof(proof); return stableJson({ policy: proof.policy, refs: proof.refs });
}
export function exactProofVersions(proof: ExactUseProof): Array<{ identity: string; version: string }> {
  assertProof(proof);
  return proof.refs.map(ref => ({ identity: ref.kind === "memory" ? `${proof.policy.requester.userId}:${ref.id}`
    : `${ref.kind}:${ref.kind === "source" ? `${ref.source}:` : ""}${proof.policy.requester.userId}:${ref.id}`, version: ref.revision }));
}

/** Initial projection admission and later reference-only admission use the same
 * physical rows and policies. No ContextPack is constructed from guessed text. */
async function admit(policy: ExactUsePolicy, expected: ExactRef[], projections?: ExactUseAdmission, previousReceiptId?: string, sequence?: number,
  physicalTickets?: ReadonlyMap<string, PhysicalTicket>) {
  const userId = policy.requester.userId;
  if (!uuid.test(userId) || !expected.length || expected.length > 256 || expected.some(ref => !uuid.test(ref.id))) throw unavailable();
  return withMemoryRecordWrite(userId, "context_log", async store => {
    await lockContextOwnerForShare(store, userId);
    const workId = policy.requester.type === "work" ? policy.requester.id : policy.requester.type === "loop" ? policy.requester.workId : undefined;
    const lease = resolveExecutionLease();
    if (lease && (policy.requester.type === "chat" || workId && workId !== lease.workshopId)) throw unavailable();
    if (["work", "loop"].includes(policy.requester.type)) {
      if (!workId || !uuid.test(workId)) throw unavailable();
      const actual = await readExactWorkBindingForShare(store, { userId, workId });
      if (!actual) throw unavailable();
      const keys = (filters: BrainSourceFilters | undefined) => [...(filters?.scenarioKeys ?? [])].sort();
      if ((previousReceiptId || policy.sourceFilters?.scenarioKeys) && stableJson(keys(actual.sourceFilters)) !== stableJson(keys(policy.sourceFilters))) throw unavailable();
      policy = { ...policy, sourceFilters: { ...policy.sourceFilters, scenarioKeys: actual.sourceFilters?.scenarioKeys } };
    }
    const memoryIds = [...new Set(expected.flatMap(ref => ref.kind === "memory" ? [ref.id]
      : ref.kind === "observation" ? [ref.sourceMemoryId, ref.targetMemoryId].filter((id): id is string => typeof id === "string") : []))].sort();
    if (memoryIds.some(id => !uuid.test(id))) throw unavailable();
    const memories = await readContextMemoriesForShare(store, userId, memoryIds);
    const byId = new Map(memories.map(memory => [memory.id, memory]));
    const grants = await readContextGrantsForShare(store, userId);
    const observations = new Map<string, NonNullable<Awaited<ReturnType<typeof readObservation>>>>();
    const snapshots = new Map<string, StateSnapshotRecord>();
    for (const source of ["brainMemories", "brainObservations", "brainStateSnapshots"] as const) {
      const projected = projections?.publishedRecords?.filter(record => record.source === source) ?? [];
      if (!projected.length) continue;
      if (policy.requester.type !== "chat" || policy.accessMode !== "owner_override") throw unavailable();
      const rows = await readExactPublishedRowsForShare(store, { userId, source, ids: projected.map(row => row.id).sort() });
      for (const projection of projected) {
        const current = rows.find(row => row.id === projection.id);
        if (!current || Object.entries(projection.fields).some(([key, value]) => !Object.hasOwn(current, key)
          || stableJson(publishedValue(value)) !== stableJson(publishedValue(current[key])))) throw unavailable();
      }
    }
    for (const ref of [...expected].sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`))) {
      if (ref.kind === "observation") {
        const row = await readObservation(store, userId, ref.id); if (!row) throw unavailable(); observations.set(ref.id, row);
      } else if (ref.kind === "snapshot") {
        const row = await readStateSnapshotInTransaction(store, { userId, snapshotId: ref.id, workId: ref.workId, lock: "share" });
        if (!row) throw unavailable(); snapshots.set(ref.id, row);
      }
    }
    const planRecords = new Map<string, NonNullable<Awaited<ReturnType<typeof readPlanSourceForShare>>>>();
    for (const ref of expected.filter((item): item is ExactPlanRef => item.kind === "plan").sort((a, b) => a.id.localeCompare(b.id))) {
      if (policy.requester.type !== "chat" || policy.accessMode !== "owner_override") throw unavailable();
      const current = await readPlanSourceForShare(store, userId, ref.id);
      if (!current || current.version !== ref.revision || current.state !== "approved") throw unavailable();
      planRecords.set(ref.id, current);
    }
    const sourceRecords = new Map<string, NonNullable<Awaited<ReturnType<typeof readSourceRecordForShare>>>>();
    const fileRecords = new Map<string, Awaited<ReturnType<typeof readFileBindingForShare>>>();
    for (const ref of expected.filter((item): item is FileBindingRef => item.kind === 'file-binding').sort((a, b) => a.id.localeCompare(b.id))) {
      if (!workId) throw unavailable();
      const authority: FileReadAuthority = { userId, workId, bindingId: ref.id, permission: ref.permission, tool: ref.tool };
      const current = await readFileBindingForShare(store, authority);
      const physical = projections?.fileBindings?.find(item => item.id === ref.id)?.physicalTicket ?? physicalTickets?.get(`file-binding:${ref.id}`);
      if (physical && physical.kind !== 'work-file-physical') throw unavailable();
      assertPhysicalTicket(physical, authority, current);
      if (current.revision !== ref.revision || current.binding.artifactId !== ref.artifactId || current.binding.artifactRevision !== ref.artifactRevision) throw unavailable();
      const receipt = await readExactArtifactEvidenceReceiptForShare(store, { userId, receiptId: ref.evidenceReceiptId });
      const range = receipt?.actualRange as { start?: unknown; end?: unknown; unit?: unknown } | undefined;
      if (!uuid.test(ref.evidenceReceiptId) || !Number.isSafeInteger(ref.start) || !Number.isSafeInteger(ref.end) || ref.start < 0 || ref.end < ref.start
        || !receipt || receipt.purpose !== 'evidence' || receipt.artifactId !== ref.artifactId || receipt.revision !== ref.artifactRevision
        || receipt.sha256 !== current.manifest.sha256 || receipt.totalLength !== current.manifest.sizeBytes || range?.unit !== 'bytes'
        || typeof range.start !== 'number' || typeof range.end !== 'number' || range.start > ref.start || range.end < ref.end) throw unavailable();
      fileRecords.set(ref.id, current);
    }
    const ragRecords = new Map<string, Awaited<ReturnType<typeof revalidateRagSourceInTransaction>>>();
    for (const ref of expected.filter((item): item is ExactSourceRef => item.kind === 'source').sort((a, b) => `${a.source}:${a.id}`.localeCompare(`${b.source}:${b.id}`))) {
      const key = `${ref.source}:${ref.id}`;
      const projection = projections?.sources?.find(record => record.source === ref.source && record.id === ref.id);
      if (ref.source === 'rag-document' || ref.source === 'rag-document-metadata') {
        if (policy.requester.type !== 'chat' || policy.accessMode !== 'owner_override') throw unavailable();
        if (!(ref.source === 'rag-document-metadata' ? /^ragmeta1:[a-f0-9]{64}$/ : /^ragdoc1:[a-f0-9]{64}$/).test(ref.revision)) throw unavailable();
        const current = projection
          ? await admitRagSourceProjectionInTransaction(store, { userId, documentId: ref.id, revision: ref.revision, projection: projection.projection })
          : await revalidateRagSourceInTransaction(store, { userId, documentId: ref.id, revision: ref.revision, metadataOnly: ref.source === 'rag-document-metadata' });
        if ((ref.source === 'rag-document-metadata') !== current.metadataOnly) throw unavailable();
        ragRecords.set(key, current);
      } else {
        const current = await readSourceRecordForShare(store, { source: ref.source, id: ref.id, requester: policy.requester, sourceFilters: policy.sourceFilters, sourceCapability: policy.sourceCapability });
        const fileDescriptorOnly = ref.source === 'workshopSources' && current?.row.type === 'file';
        if (previousReceiptId && fileDescriptorOnly && ref.representation !== "file_source_descriptor.v1") throw unavailable();
        if (!current || ref.revision && current.revision !== ref.revision || projection &&
          (fileDescriptorOnly ? !matchesSourceProjection(current.projectionRow, projection.projection)
            : !matchesSourceProjection(current.row, projection.projection) && !matchesSourceProjection(current.projectionRow, projection.projection))) throw unavailable();
        sourceRecords.set(key, current);
      }
    }
    // Freshness is checked after every physical source and authority lock has
    // been acquired, including an unchanged legacy row whose TTL elapsed.
    const now = new Date();
    for (const memoryId of memoryIds) { const memory = byId.get(memoryId); if (!memory) throw unavailable(); assertMemory(memory, policy, grants, now); }
    const checked: ExactRef[] = [];
    for (const ref of expected) {
      if (ref.kind === "memory") {
        const current = byId.get(ref.id)!;
        const revision = getBrainMemoryRevisionVersion(current);
        const published = projections?.publishedRecords?.some(record => record.source === "brainMemories" && record.id === ref.id);
        if (ref.revision ? revision !== ref.revision : !published) throw unavailable();
        const projection = projections?.memories?.find(memory => memory.id === ref.id);
        if (projection && (projection.userId !== current.userId || projection.subject !== current.subject || projection.content !== current.content
          || projection.ownerType !== current.ownerType || projection.ownerId !== current.ownerId || projection.memoryType !== current.memoryType)) throw unavailable();
        checked.push({ ...ref, revision });
      } else if (ref.kind === "observation") {
        const current = observations.get(ref.id)!;
        if (ref.sourceMemoryId && ref.targetMemoryId) {
          const parent = byId.get(ref.sourceMemoryId)!, target = byId.get(ref.targetMemoryId)!;
          if (!parent.evidenceRefs.includes(`brain-observation:${ref.id}`) || current.metadata.memoryId !== target.id) throw unavailable();
        } else if (policy.requester.type !== "chat" || policy.accessMode !== "owner_override") throw unavailable();
        const revision = observationVersion(current).revision;
        if (ref.revision && revision !== ref.revision) throw unavailable();
        const projection = projections?.observations?.find(row => row.id === ref.id);
        if (projection && projection.content !== current.content) throw unavailable();
        checked.push({ ...ref, revision });
      } else if (ref.kind === "snapshot") {
        const current = snapshots.get(ref.id)!;
        const revision = stateSnapshotRevisionVersion(current);
        const published = projections?.publishedRecords?.some(record => record.source === "brainStateSnapshots" && record.id === ref.id);
        if ((ref.revision ? revision !== ref.revision : !published)
          || ref.snapshotTypes?.length && !ref.snapshotTypes.includes(current.snapshotType)
          || ref.recordedBefore && Date.parse(current.createdAt) > Date.parse(ref.recordedBefore)) throw unavailable();
        const expectedWork = policy.requester.type === "loop" ? policy.requester.workId : policy.requester.type === "work" ? policy.requester.id : undefined;
        if (expectedWork && ref.workId !== expectedWork) throw unavailable();
        checked.push({ ...ref, revision });
      } else if (ref.kind === "source") {
        if (ref.source === "rag-document" || ref.source === "rag-document-metadata") {
          const current = ragRecords.get(`${ref.source}:${ref.id}`)!;
          checked.push({ ...ref, revision: current.revision });
        } else {
          const current = sourceRecords.get(`${ref.source}:${ref.id}`)!;
          if (['workshopMemories', 'interactionMemories'].includes(ref.source) && current.row.expiresAt
            && Date.parse(String(current.row.expiresAt)) <= now.getTime()) throw unavailable();
          checked.push({ ...ref, revision: current.revision,
            ...(ref.source === "workshopSources" && current.row.type === "file" ? { representation: "file_source_descriptor.v1" as const } : {}) });
        }
      } else if (ref.kind === "plan") {
        if (Date.parse(planRecords.get(ref.id)!.expiresAt) <= now.getTime()) throw unavailable();
        checked.push(ref);
      } else if (ref.kind === 'file-binding') {
        if (fileRecords.get(ref.id)!.binding.expiresAt.getTime() <= now.getTime()) throw unavailable();
        checked.push(ref);
      } else {
        if (policy.requester.type !== "chat" || policy.accessMode !== "owner_override" || !uuid.test(ref.evidenceReceiptId)
          || !Number.isSafeInteger(ref.start) || !Number.isSafeInteger(ref.end) || ref.start < 0 || ref.end < ref.start) throw unavailable();
        const manifest = await revalidateArtifactInTransaction(store, { userId, artifactId: ref.id, revision: ref.revision });
        if (previousReceiptId) assertArtifactPhysicalTicket(physicalTickets?.get(`artifact:${ref.id}`), userId, manifest);
        const receipt = await readExactArtifactEvidenceReceiptForShare(store, { userId, receiptId: ref.evidenceReceiptId });
        const range = receipt?.actualRange as { start?: unknown; end?: unknown; unit?: unknown } | undefined;
        if (!receipt || receipt.artifactId !== ref.id || receipt.purpose !== "evidence" || receipt.revision !== ref.revision
          || receipt.sha256 !== manifest.sha256 || receipt.totalLength !== manifest.sizeBytes || range?.unit !== "bytes"
          || typeof range.start !== "number" || typeof range.end !== "number" || range.start > ref.start || range.end < ref.end) throw unavailable();
        checked.push(ref);
      }
    }
    // Independent observation authorization also binds the exact canonical
    // versions of its stored parent and provenance target, including history.
    for (const memory of memories) if (!checked.some(ref => ref.kind === "memory" && ref.id === memory.id)) {
      checked.push({ kind: "memory", id: memory.id, revision: getBrainMemoryRevisionVersion(memory) });
    }
    if (checked.length > 256) throw unavailable();
    const created = await insertContextLogInTransaction(store, { userId, requesterType: policy.requester.type,
      requesterId: policy.requester.id ?? policy.requester.workId ?? null, taskIntent: policy.purpose,
      selectedMemoryIds: memoryIds, denied: [], omitted: [], metadata: { source: sequence === undefined ? "memory_exact_use_admission" : "memory_exact_use_dispatch",
        exactUse: { schemaVersion: "memory-exact-use.v1", purpose: policy.purpose, checkedAt: now.toISOString(), refs: checked, policy: policyFor(policy),
          previousReceiptId: previousReceiptId ?? null, dispatchSequence: sequence ?? null, sourceFilters: policy.sourceFilters ?? null,
          ...(checked.some(ref => ref.kind === 'file-binding') ? { fileBindingCheck: 'physical_digest_then_transaction_authority_revalidated', objectBodyReread: true }
            : checked.some(ref => ref.kind === 'artifact') ? { artifactCheck: previousReceiptId ? 'physical_digest_then_manifest_revalidated' : 'manifest_revalidated',
              objectBodyReread: Boolean(previousReceiptId) } : {}) } } });
    const proof: ExactUseProof = freezeDeep({ policy: policyFor(policy), refs: structuredClone(checked), receiptId: created.id });
    issued.add(proof);
    return { id: created.id, result: proof };
  });
}

export async function admitExactUse(input: ExactUseAdmission): Promise<ExactUseProof> {
  const refs: ExactRef[] = [
    ...(input.memories ?? []).map(memory => ({ kind: "memory" as const, id: memory.id, revision: getBrainMemoryRevisionVersion(memory) })),
    ...(input.memoryRefs ?? []).map(ref => ({ kind: "memory" as const, id: ref.id, revision: ref.revision })),
    ...(input.observations ?? []).map(ref => ({ kind: "observation" as const, id: ref.id, revision: "", sourceMemoryId: ref.sourceMemoryId, targetMemoryId: ref.targetMemoryId })),
    ...(input.snapshots ?? []).map(value => ({ kind: "snapshot" as const, id: value.record.id, revision: stateSnapshotRevisionVersion(value.record),
      workId: value.workId, snapshotTypes: value.snapshotTypes, recordedBefore: value.recordedBefore })),
    ...(input.publishedRecords ?? []).map(record => ({ kind: record.source === "brainMemories" ? "memory" as const
      : record.source === "brainObservations" ? "observation" as const : "snapshot" as const, id: record.id, revision: "" })),
    ...(input.artifacts ?? []).map(record => ({ kind: "artifact" as const, ...record })),
    ...(input.fileBindings ?? []).map(({ physicalTicket: _physicalTicket, ...ref }) => ref),
    ...(input.plans ?? []).map(ref => ({ kind: "plan" as const, ...ref })),
    ...(input.sources ?? []).map(record => ({ kind: "source" as const, source: record.source, id: record.id, revision: record.revision ?? "" })),
  ];
  return admit(policyFor(input), refs, input);
}
export async function prepareExactUseRevalidation(proof: ExactUseProof): Promise<ReadonlyMap<string, PhysicalTicket>> {
  assertProof(proof);
  const result = new Map<string, PhysicalTicket>();
  const workId = proof.policy.requester.type === 'work' ? proof.policy.requester.id : proof.policy.requester.type === 'loop' ? proof.policy.requester.workId : undefined;
  for (const ref of proof.refs) if (ref.kind === 'file-binding') {
    if (!workId) throw unavailable();
    result.set(`file-binding:${ref.id}`, await prepareFilePhysical({ userId: proof.policy.requester.userId, workId, bindingId: ref.id,
      permission: ref.permission, tool: ref.tool }, ref.revision));
  } else if (ref.kind === 'artifact') result.set(`artifact:${ref.id}`, await prepareArtifactPhysical(proof.policy.requester.userId, ref.id, ref.revision));
  return result;
}
export async function revalidateExactUse(proof: ExactUseProof, sequence: number, physicalTickets?: ReadonlyMap<string, PhysicalTicket>): Promise<ExactUseProof> {
  assertProof(proof); return admit(proof.policy, [...proof.refs], undefined, proof.receiptId, sequence, physicalTickets);
}

export type PreparedPersistedExactUse = Readonly<{ receiptId: string; signature: string }>;
const preparedReceipts = new WeakMap<PreparedPersistedExactUse, { proof: ExactUseProof; physical: ReadonlyMap<string, PhysicalTicket> }>();
/** Read only a durable, owned admission. Caller supplied proofs or old receipts
 * without a complete recorded policy require a fresh authorized read. */
export async function preparePersistedExactUse(userId: string, receiptId: string): Promise<PreparedPersistedExactUse> {
  if (!uuid.test(userId) || !uuid.test(receiptId)) throw unavailable();
  const proof = await withDatabaseTransaction(async () => {
    const row = await readOwnedContextLogForShare(db, userId, receiptId);
    const metadata = row?.metadata as Record<string, unknown> | undefined;
    if (!row || row.requesterType !== "chat" || !["memory_exact_use_admission", "memory_exact_use_dispatch"].includes(String(metadata?.source))) throw unavailable();
    const parsed = persistedExactSchema.safeParse(metadata?.exactUse);
    if (!parsed.success || parsed.data.policy.requester.userId !== userId) throw unavailable();
    const value: ExactUseProof = freezeDeep({ policy: parsed.data.policy, refs: parsed.data.refs as ExactRef[], receiptId });
    issued.add(value); return value;
  });
  const physical = await prepareExactUseRevalidation(proof);
  const ticket = Object.freeze({ receiptId, signature: exactProofKey(proof) });
  preparedReceipts.set(ticket, { proof, physical }); return ticket;
}
export async function admitPersistedExactUse(ticket: PreparedPersistedExactUse): Promise<ExactUseProof> {
  const prepared = preparedReceipts.get(ticket); if (!prepared) throw unavailable();
  return admit(prepared.proof.policy, [...prepared.proof.refs], undefined, prepared.proof.receiptId, undefined, prepared.physical);
}
