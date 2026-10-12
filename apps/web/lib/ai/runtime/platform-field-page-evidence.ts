import { formatPlatformFieldPageResult, type PlatformFieldPageResult, type PlatformFieldWindow, type PlatformFieldManifest, type PlatformFieldPageBinding } from "../platform-field-pages";
import type { ToolConstruction } from "./answer-evidence-contract";
import { answerEvidenceHash, answerTextHash } from "./answer-evidence-core";
import type { PlatformAnswerReceipt, PlatformAnswerSessionOptions } from "./platform-answer-contract";
import { platformSupportsFieldPages } from "../platform-read-handle-registry";
const hashPattern = /^[a-f0-9]{64}$/u, uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const keyFor = (b: PlatformFieldPageBinding) => JSON.stringify([b.ownerId, b.requester.kind, b.requester.id, b.turnId, b.source, b.id, b.fieldKey, b.parentContentHash]);
const validBinding = (b: PlatformFieldPageBinding, options: PlatformAnswerSessionOptions) => b && b.ownerId === options.ownerId && b.turnId === options.turnId
  && b.requester?.kind === "chat" && typeof b.requester.id === "string" && !!b.requester.id
  && uuidPattern.test(b.id) && platformSupportsFieldPages(b.source, b.fieldKey) && hashPattern.test(b.parentContentHash);
/** This projector accepts only the guarded host result plus the exact model-facing wire. No model parameters create a binding. */
export function projectPlatformFieldPageReceipt(input: ToolConstruction, options: PlatformAnswerSessionOptions): PlatformAnswerReceipt | undefined {
  const result = input.result as PlatformFieldPageResult;
  if (input.toolName !== "platformRecall" || !result?.fieldPage || typeof input.modelText !== "string" || input.modelText.length > 8000
    || result.fieldPage.schemaVersion !== "platform-field-page.v2" || result.fieldPage.partial !== true) return undefined;
  try { if (input.modelText !== formatPlatformFieldPageResult(result)) return undefined; } catch { return undefined; }
  const page = result.fieldPage, manifest = result.hostFieldManifest, facts: PlatformAnswerReceipt["facts"] = [];
  let binding: PlatformFieldPageBinding, observedAt: string;
  if ("binding" in page) {
    binding = page.binding; observedAt = page.observation?.observedAt;
    if (!validBinding(binding, options) || page.content !== "" || result.ok !== false || result.isError !== true
      || !["permission_denied", "version_changed", "not_found_in_scope", "not_published", "conflicting_aliases", "invalid_source_identity", "field_exceeds_existing_total_budget", "metadata_exceeds_window_budget", "invalid_cursor_offset", "query_error"].includes(page.status)) return undefined;
    facts.push({ kind: "gap", source: binding.source, id: binding.id, fieldKey: binding.fieldKey, state: page.status === "permission_denied" ? "denied" : "unknown", reason: page.status, observedAt });
  } else {
    if (!manifest || manifest.schemaVersion !== "platform-field-manifest.v1" || !validBinding(manifest.binding, options)
      || manifest.codec !== "json_stringify_utf16" || manifest.scope !== "authenticated_owner_exact_source" || manifest.coverage?.fieldComplete !== false
      || manifest.coverage.rawRecordComplete !== false || !hashPattern.test(manifest.fieldHash) || !Number.isSafeInteger(manifest.totalCharacters)
      || manifest.totalCharacters < 1 || manifest.totalCharacters > 64000 || answerTextHash(JSON.stringify(manifest)) !== page.manifestHash
      || page.readHandle !== manifest.readHandle || !/^pfr_[A-Za-z0-9_-]{32}$/u.test(page.readHandle) || result.ok !== true || result.isError !== false) return undefined;
    binding = manifest.binding; observedAt = manifest.observation?.observedAt;
    try {
      if (!options.resolveFieldPageReadHandle) return undefined;
      const registered = options.resolveFieldPageReadHandle(manifest.readHandle);
      if (registered.ownerId !== binding.ownerId || registered.turnId !== binding.turnId || answerEvidenceHash(registered.requester) !== answerEvidenceHash(binding.requester)
        || registered.source !== binding.source || registered.id !== binding.id || registered.fieldKey !== binding.fieldKey || registered.contentHash !== binding.parentContentHash) return undefined;
    } catch { return undefined; }
    if (!['read_window', 'not_recorded_window'].includes(page.status) || typeof page.content !== "string" || page.content.length < 1
      || !Number.isSafeInteger(page.offset) || page.offset < 0 || page.end !== page.offset + page.content.length || page.end > manifest.totalCharacters
      || answerTextHash(JSON.stringify(page.content)) !== page.chunkHash || (page.end === manifest.totalCharacters ? page.nextCursor !== null : !/^pfp_[A-Za-z0-9_-]{32}$/u.test(String(page.nextCursor)))
      || page.manifest && (page.offset !== 0 || answerEvidenceHash(page.manifest) !== answerEvidenceHash(manifest))) return undefined;
  }
  if (!Number.isFinite(Date.parse(observedAt)) || options.snapshotAt && ("binding" in page ? page.observation.kind : manifest!.observation.kind) !== "frozen_capture") return undefined;
  const receiptBody = { schemaVersion: "platform-answer-receipt.v1" as const, evidenceId: `${options.turnId}:${input.toolCallId}`,
    turnId: options.turnId, toolUseId: input.toolCallId, authorization: { ownerId: options.ownerId, policyHash: options.policyHash,
      toolPolicyDecision: "allowed" as const, decision: facts.some(f => f.kind === "gap" && f.state === "denied") ? "denied" as const : "allowed" as const, checkedAt: input.trace.timestamp },
    observation: { kind: options.snapshotAt ? "snapshot" as const : "live" as const, observedAt }, delivery: "result_constructed" as const,
    facts, fieldPageReceipt: clone(result) };
  return { ...receiptBody, source: { name: "published_platform_adapter", resultHash: answerEvidenceHash(input.result), receiptHash: answerEvidenceHash(receiptBody) } };
}
type Group = { binding: PlatformFieldPageBinding; pages: PlatformAnswerReceipt[]; gap?: string; denied: boolean };
/** Derived field facts are render projections of actual same-core committed receipts. They never enter or impersonate a core construction. */
export function aggregatePlatformCommittedFieldPages(contextReceipts: readonly PlatformAnswerReceipt[], emittedReceipts: readonly PlatformAnswerReceipt[], options: PlatformAnswerSessionOptions): PlatformAnswerReceipt[] {
  const emitted = new Map(emittedReceipts.map(receipt => [receipt.evidenceId, receipt])), groups = new Map<string, Group>();
  const groupFor = (binding: PlatformFieldPageBinding) => {
    const key = keyFor(binding); let group = groups.get(key);
    if (!group) { group = { binding, pages: [], denied: false }; groups.set(key, group); } return group;
  };
  // Current host denial dominates even when the denied body was withheld from context.
  for (const receipt of emittedReceipts) if (receipt.fieldPageReceipt && "binding" in receipt.fieldPageReceipt.fieldPage) {
    const gap = receipt.fieldPageReceipt.fieldPage;
    if (validBinding(gap.binding, options)) { const group = groupFor(gap.binding); group.gap = gap.status; group.denied ||= gap.status === "permission_denied"; }
  }
  for (const receipt of contextReceipts) {
    const result = receipt.fieldPageReceipt; if (!result?.hostFieldManifest || "binding" in result.fieldPage) continue;
    const binding = result.hostFieldManifest.binding; if (!validBinding(binding, options)) continue;
    const group = groupFor(binding), matched = emitted.get(receipt.evidenceId);
    if (!matched?.fieldPageReceipt || answerEvidenceHash(matched.fieldPageReceipt) !== answerEvidenceHash(result)) { group.gap = "missing_or_mismatched_emission"; continue; }
    group.pages.push(receipt);
  }
  const derived: PlatformAnswerReceipt[] = [];
  for (const group of groups.values()) {
    let next = 0, content = "", manifest: PlatformFieldManifest | undefined, complete = false;
    const evidenceIds: string[] = [], seen = new Set<string>();
    for (const receipt of group.pages) {
      const result = receipt.fieldPageReceipt!, page = result.fieldPage as PlatformFieldWindow, current = result.hostFieldManifest!;
      if (seen.has(receipt.evidenceId) || page.offset !== next || complete || manifest && answerEvidenceHash(manifest) !== answerEvidenceHash(current)
        || answerTextHash(JSON.stringify(page.content)) !== page.chunkHash) { group.gap = "noncontiguous_duplicate_or_mixed_manifest"; break; }
      if (next === 0 && !page.manifest) { group.gap = "missing_committed_manifest"; break; }
      seen.add(receipt.evidenceId); evidenceIds.push(receipt.evidenceId); manifest = current; content += page.content; next = page.end; complete = page.nextCursor === null;
    }
    if (!group.gap && (!complete || !manifest || next !== manifest.totalCharacters)) group.gap = "partial_field_pages";
    if (!group.gap && manifest && !contextReceipts.some(receipt => emitted.has(receipt.evidenceId) && receipt.readHandles?.some(handle => handle.readHandle === manifest!.readHandle
      && handle.source === group.binding.source && handle.id === group.binding.id && handle.fieldKey === group.binding.fieldKey && handle.parentContentHash === group.binding.parentContentHash))) group.gap = "missing_committed_discovery_binding";
    if (!group.gap && manifest && answerTextHash(content) !== manifest.fieldHash) group.gap = "field_hash_mismatch";
    let value: unknown;
    if (!group.gap) try { value = JSON.parse(content); } catch { group.gap = "field_json_invalid"; }
    const first = group.pages[0] ?? emittedReceipts.find(receipt => receipt.fieldPageReceipt && "binding" in receipt.fieldPageReceipt.fieldPage && keyFor(receipt.fieldPageReceipt.fieldPage.binding) === keyFor(group.binding));
    if (!first) continue;
    const observedAt = manifest?.observation.observedAt ?? first.observation.observedAt!;
    const facts: PlatformAnswerReceipt["facts"] = group.gap || group.denied
      ? [{ kind: "gap", source: group.binding.source, id: group.binding.id, fieldKey: group.binding.fieldKey, state: group.denied ? "denied" : "unknown", reason: group.denied ? "permission_denied" : group.gap!, observedAt }]
      : [{ kind: "field", source: group.binding.source, id: group.binding.id, fieldKey: group.binding.fieldKey, value, state: value === null ? "not_recorded" : "supported",
        observedAt, contentHash: group.binding.parentContentHash, scope: "owner_exact_record", retrievalEvidenceIds: evidenceIds }];
    derived.push({ ...first, facts, fieldPageReceipt: undefined });
  }
  return derived;
}
