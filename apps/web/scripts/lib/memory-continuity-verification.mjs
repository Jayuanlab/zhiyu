/** Pure independent acceptance checks. Never imports the implementation under evaluation. */
import { createHash } from "node:crypto";

export function canonical(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  throw Error("Expected complete JSON evidence");
}
export const same = (left, right) => {
  try { return canonical(left) === canonical(right); } catch { return false; }
};
export const canonicalHash = value => createHash("sha256").update(canonical(value)).digest("hex");
const object = value => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const time = value => typeof value === "string" ? Date.parse(value) : NaN;
const sorted = values => [...values].sort();
const uniqueStrings = values => Array.isArray(values) && values.every(value => typeof value === "string" && value.length > 0) && new Set(values).size === values.length;
const numeric = value => Number.isSafeInteger(value) && value >= 0;
const sha = value => typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);

export function inputTextParts(payload) {
  const output = [];
  const visit = value => {
    if (typeof value === "string") output.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") {
      if (typeof value.text === "string") output.push(value.text);
      if (value.content !== undefined) visit(value.content);
    }
  };
  visit(payload.system);
  for (const message of payload.messages ?? payload.input ?? []) {
    if (typeof message === "object" && ["user", "system", "developer"].includes(message.role)) visit(message.content);
  }
  return output;
}

/** Parse actual JSON following a known host section, respecting quoted braces. */
export function embeddedObjects(text, marker) {
  const objects = [];
  let from = 0;
  while (from < text.length) {
    const at = text.indexOf(marker, from);
    if (at < 0) break;
    const start = text.indexOf("{", at + marker.length);
    if (start < 0) break;
    let depth = 0, quoted = false, escaped = false, end = -1;
    for (let index = start; index < text.length; index++) {
      const char = text[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === "{") depth++;
      else if (char === "}" && --depth === 0) { end = index + 1; break; }
    }
    if (end < 0) break;
    try { objects.push(JSON.parse(text.slice(start, end))); } catch { /* Incomplete JSON is never accepted by string matching. */ }
    from = end;
  }
  return objects;
}

export function continuityFromPayload(payload) {
  return inputTextParts(payload).flatMap(text => embeddedObjects(text, "历史工作检查点（未核实，仅同一连续任务的接续材料）："));
}
export function continuityAuditResult(metadata) {
  const { schemaVersion, status, reason, warnings, checkpoint } = object(metadata);
  return { schemaVersion, status, reason, warnings, checkpoint };
}

export function verifyDispatchOrder(round) {
  const errors = [], mapping = [];
  const prepared = round.events.filter(event => event.type === "working_memory_projected" && event.metadata?.receiptAuthority === "runtime"
    && event.metadata.status === "provider_request_prepared").sort((a, b) => a.seq - b.seq);
  const usage = round.events.filter(event => event.type === "working_memory_usage" && event.metadata?.receiptAuthority === "runtime").sort((a, b) => a.seq - b.seq);
  const requests = round.providerRequests.filter(request => request.kind === "working-memory-agent");
  if (!requests.length || requests.length !== prepared.length || requests.length !== usage.length) errors.push("main_request_prepared_usage_count_mismatch");
  const mapped = new Set();
  for (let index = 0; index < requests.length; index++) {
    const request = requests[index], binding = request.hostPrepared, event = prepared[index], result = usage[index], next = prepared[index + 1];
    const failure = [];
    if (!event || !result || !binding || binding.eventId !== event.id || binding.seq !== event.seq || binding.loopRunId !== event.loopRunId
      || binding.version !== event.metadata.version || !same(binding.policyIdentity, event.metadata.policyIdentity) || binding.createdAt !== event.createdAt) failure.push("prepared_binding_mismatch");
    if (event && mapped.has(event.id)) failure.push("prepared_receipt_reused");
    if (event) mapped.add(event.id);
    if (!event || !result || !Number.isFinite(time(request.dispatchedAt)) || !Number.isFinite(time(event.createdAt)) || !Number.isFinite(time(result.createdAt))
      || time(event.createdAt) > time(request.dispatchedAt) || time(request.dispatchedAt) > time(result.createdAt)
      || event.seq >= result.seq || next && (result.seq >= next.seq || time(result.createdAt) > time(next.createdAt))) failure.push("prepared_dispatch_result_order_mismatch");
    if (!result || result.metadata.invocation !== index + 1 || result.metadata.version !== event?.metadata.version
      || result.metadata.model !== request.model || !same(result.metadata.policyIdentity, event?.metadata.policyIdentity)) failure.push("result_identity_mismatch");
    if (!event || event.loopRunId !== round.result?.loopRunId || event.loopId !== round.before.loopId || event.workshopId !== round.before.workshopId) failure.push("prepared_run_scope_mismatch");
    if (!(request.responseStatus >= 200 && request.responseStatus < 300) || request.error !== null) failure.push("main_provider_request_failed");
    if (failure.length) errors.push(...failure.map(code => `${request.index}:${code}`));
    mapping.push({ requestIndex: request.index, preparedEventId: event?.id ?? null, preparedSeq: event?.seq ?? null,
      preparedAt: event?.createdAt ?? null, dispatchedAt: request.dispatchedAt, usageEventId: result?.id ?? null,
      usageSeq: result?.seq ?? null, resultAt: result?.createdAt ?? null, passed: failure.length === 0, errors: failure });
  }
  return { passed: !errors.length, errors, mapping };
}

/** Reconstruct exact promotion binding using saved observations, without calling promotion code. */
export function verifyPromotion({ initial, promotion, ownerId, workshopId, loopId }) {
  try { return verifyPromotionEvidence({ initial, promotion, ownerId, workshopId, loopId }); }
  catch { return { passed: false, errors: ["invalid_promotion_evidence_structure"] }; }
}
function verifyPromotionEvidence({ initial, promotion, ownerId, workshopId, loopId }) {
  const errors = [], { command } = promotion, memory = promotion.memory?.memory, data = object(memory?.metadata?.workingMemoryPromotion);
  const events = initial.events, checkpoints = events.filter(event => ["working_memory_updated", "working_memory_restored"].includes(event.type)
    && event.metadata?.receiptAuthority === "runtime").sort((a, b) => a.seq - b.seq);
  const checkpoint = checkpoints.at(-1), prepared = events.find(event => event.id === data.projectionEventId);
  const check = (condition, code) => { if (!condition) errors.push(code); };
  check(command?.runKind === "loop" && command.loopId === loopId && command.runId === initial.result?.loopRunId, "promotion_command_run_mismatch");
  check(memory?.id === promotion.result?.candidateId && memory?.userId === ownerId && memory?.ownerType === "work" && memory?.ownerId === workshopId
    && same(memory?.scope, { type: "work", workId: workshopId }) && memory.status === "candidate" && promotion.result?.status === "candidate", "candidate_owner_scope_or_fence_mismatch");
  check(checkpoint?.id === data.checkpointEventId && checkpoint?.type === "working_memory_updated" && checkpoint?.metadata.mode === "apply"
    && checkpoint.metadata.status === "ready_for_projection" && checkpoint.metadata.version === command?.expectedVersion && data.expectedVersion === command?.expectedVersion, "checkpoint_key_version_mismatch");
  const notes = [ ...(checkpoint?.metadata.state?.facts ?? []).map(note => ({ ...note, category: "fact" })),
    ...(checkpoint?.metadata.state?.hypotheses ?? []).map(note => ({ ...note, category: "hypothesis" })) ].filter(note => note.key === command?.noteKey);
  const note = notes.length === 1 ? notes[0] : null;
  check(note && memory.content === note.text && memory.memoryType === (note.category === "fact" ? "fact" : "insight")
    && data.category === note.category && data.authority === "model-authored-unverified" && data.source === "working-memory-promotion.v1"
    && data.commandId === command.commandId && memory.subject.endsWith(` / ${command.noteKey}`), "candidate_note_content_category_key_mismatch");
  const identity = { runKind: "loop", loopId, runId: initial.result?.loopRunId };
  check(same(data.runIdentity, identity) && data.requestHash === canonicalHash([identity, command?.noteKey, command?.expectedVersion]), "promotion_request_identity_hash_mismatch");
  check(prepared?.type === "working_memory_projected" && prepared.metadata?.receiptAuthority === "runtime" && prepared.metadata.status === "provider_request_prepared"
    && prepared.metadata.version === command?.expectedVersion && prepared.seq > checkpoint?.seq && same(prepared.metadata.policyIdentity, checkpoint?.metadata.policyIdentity)
    && same(data.policyIdentity, checkpoint?.metadata.policyIdentity), "post_checkpoint_prepared_receipt_mismatch");
  check(initial.providerRequests?.filter(request => request.kind === "working-memory-agent" && request.hostPrepared?.eventId === prepared?.id
    && request.hostPrepared.seq === prepared?.seq && request.hostPrepared.version === command?.expectedVersion
    && request.responseStatus >= 200 && request.responseStatus < 300 && request.error === null).length === 1, "promoted_checkpoint_not_bound_to_actual_main_dispatch");
  const sourceDescriptors = [];
  check(note && uniqueStrings(note.evidenceIds) && note.evidenceIds.length > 0, "missing_unique_source_references");
  for (const toolCallId of note?.evidenceIds ?? []) {
    const before = checkpoint.metadata.evidenceCatalog?.filter(entry => entry.toolCallId === toolCallId) ?? [];
    const after = prepared?.metadata.evidenceCatalog?.filter(entry => entry.toolCallId === toolCallId) ?? [];
    const entry = before.length === 1 ? before[0] : {}, projected = after.length === 1 ? after[0] : {}, sourceIdentity = object(entry.sourceIdentity);
    const sourceId = sourceIdentity.sourceEventId ?? sourceIdentity.evidenceEventId;
    const sourceMatches = events.filter(event => event.id === sourceId), source = sourceMatches.length === 1 ? sourceMatches[0] : null, raw = object(source?.metadata);
    check(before.length === 1 && after.length === 1 && entry.referenceEligible === true && projected.referenceEligible === true
      && entry.sourceIdentityStatus === "reported" && projected.sourceIdentityStatus === "reported" && same(sourceIdentity, projected.sourceIdentity)
      && sha(entry.contentHash) && entry.contentHash === projected.contentHash, `${toolCallId}:catalog_or_tool_return_hash_mismatch`);
    check(source?.type === "source_checked" && raw.receiptAuthority === "runtime" && raw.ok === true && raw.toolName === "webReadPage"
      && raw.toolName === entry.toolName && (raw.toolUseId ?? raw.toolCallId) === toolCallId && source.seq < checkpoint.seq
      && source.workshopId === workshopId && source.loopId === loopId && source.loopRunId === command.runId, `${toolCallId}:exact_source_call_scope_mismatch`);
    check(sha(sourceIdentity.contentHash) && sourceIdentity.contentHash === raw.contentHash && sourceIdentity.evidenceId === raw.evidenceId
      && numeric(sourceIdentity.offset) && numeric(sourceIdentity.contentLength) && sourceIdentity.contentLength > 0 && numeric(sourceIdentity.totalChars)
      && ["offset", "contentLength", "totalChars", "sourceVersion"].every(key => sourceIdentity[key] === raw[key])
      && sourceIdentity.offset + sourceIdentity.contentLength <= sourceIdentity.totalChars, `${toolCallId}:source_snapshot_window_version_mismatch`);
    const strings = value => Array.isArray(value) ? value.filter(item => typeof item === "string" && item.trim()) : [];
    sourceDescriptors.push({ toolCallId, sourceEventId: sourceId, evidenceId: raw.evidenceId, contentHash: raw.contentHash,
      sourceVersion: raw.sourceVersion ?? `sha256:${raw.contentHash}`, sourceVersionKind: raw.sourceVersion === undefined ? "content_hash" : "reported",
      span: { offset: sourceIdentity.offset, contentLength: sourceIdentity.contentLength, totalChars: sourceIdentity.totalChars },
      provider: typeof raw.provider === "string" && raw.provider.trim() ? raw.provider : null, detail: typeof raw.detail === "string" && raw.detail.trim() ? raw.detail : null,
      warningCodes: [...new Set([...strings(raw.warnings), ...strings(entry.sourceCautions?.warningCodes)])],
      warningTexts: [...new Set([...strings(raw.warning ? [raw.warning] : []), ...strings(entry.sourceCautions?.warningTexts)])], finalUrlVerified: raw.finalUrlVerified === true });
  }
  sourceDescriptors.sort((a, b) => a.toolCallId.localeCompare(b.toolCallId));
  check(same(data.sources, sourceDescriptors) && same(sorted(memory?.evidenceRefs ?? []), sorted([...new Set(sourceDescriptors.map(source => source.sourceEventId))])), "candidate_exact_source_descriptors_mismatch");
  if (note && sourceDescriptors.length) {
    const digest = canonicalHash(["working-memory-promotion.v1", ownerId, workshopId, identity, command.noteKey, note.category, note.text, sourceDescriptors]);
    const id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
    check(id === memory?.id, "candidate_stable_identity_mismatch");
  }
  const receipt = promotion.events?.find(event => event.type === "working_memory_promoted" && event.metadata?.commandId === command.commandId);
  check(receipt?.metadata.candidateId === memory?.id && receipt.metadata.status === "candidate" && receipt.metadata.version === command?.expectedVersion
    && receipt.metadata.checkpointEventId === checkpoint?.id && receipt.metadata.projectionEventId === prepared?.id && receipt.metadata.noteKey === command?.noteKey
    && same(receipt.metadata.runIdentity, identity) && same(sorted(receipt.metadata.sourceEventIds ?? []), sorted(memory?.evidenceRefs ?? [])), "promotion_owner_receipt_mismatch");
  return { passed: !errors.length, errors, checkpointEventId: checkpoint?.id ?? null, preparedEventId: prepared?.id ?? null, sourceCount: sourceDescriptors.length };
}

const memoryIdentity = memory => ({ id: memory?.id, userId: memory?.userId, scope: memory?.scope, ownerType: memory?.ownerType, ownerId: memory?.ownerId,
  memoryType: memory?.memoryType, subject: memory?.subject, content: memory?.content, evidenceRefs: memory?.evidenceRefs,
  confidence: memory?.confidence, tags: memory?.tags ?? [], supersedes: memory?.supersedes ?? [], metadata: memory?.metadata ?? {} });
export function verifyReview(review, expectedMemory) {
  const before = review?.before?.memory, after = review?.after?.memory, result = review?.result?.memory ?? review?.result;
  return !!expectedMemory && review?.request?.memoryId === expectedMemory.id && review.request.expectedVersion === review.before.expectedVersion
    && review.request.requester?.type === "chat" && review.request.requester.userId === expectedMemory.userId && review.request.evidenceConfirmed === true
    && review.request.reason?.trim() && review.request.decision === "confirmed" && before?.status === "candidate" && after?.status === "verified"
    && same(memoryIdentity(before), memoryIdentity(expectedMemory)) && same(memoryIdentity(before), memoryIdentity(after))
    && same(memoryIdentity(result), memoryIdentity(after)) && result.status === "verified";
}

export function verifyCorrection(correction, originalMemory) {
  const { request, result, before, afterOld, afterNew } = correction;
  return request.operation === "correct" && request.authority === "owner_statement" && request.expectedVersion === before.expectedVersion
    && before.memory.id === originalMemory.id && before.memory.content === originalMemory.content && before.memory.userId === originalMemory.userId
    && result.commandId === request.commandId && result.oldMemory.id === originalMemory.id && result.newMemory?.id === afterNew.memory.id
    && result.receipt.oldMemoryId === originalMemory.id && result.receipt.newMemoryId === afterNew.memory.id
    && afterOld.memory.id === originalMemory.id && afterOld.memory.status === "superseded" && afterOld.memory.content === originalMemory.content
    && afterOld.memory.metadata?.revisionRetired?.nextMemoryId === afterNew.memory.id
    && afterNew.memory.id !== originalMemory.id && afterNew.memory.content === request.content && result.newMemory.content === request.content
    && same(afterNew.memory.supersedes, [originalMemory.id]) && same(afterNew.memory.scope, originalMemory.scope)
    && afterNew.memory.ownerType === originalMemory.ownerType && afterNew.memory.ownerId === originalMemory.ownerId && afterNew.memory.userId === originalMemory.userId
    && afterNew.memory.metadata?.revision?.commandId === request.commandId && afterNew.memory.metadata.revision.previousMemoryId === originalMemory.id;
}
