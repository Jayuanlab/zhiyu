import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";
import { validatePlatformPublishedFactValue, platformPublishedRecordFactSchema } from "./platform-published-record-facts";
import { Type } from "@earendil-works/pi-ai";
import type { createMemoryReadBudget } from "./memory-read-budget";
import { selectPlatformAnswerContract } from "./runtime/platform-answer-contract";
import { PlatformReadHandleRegistry, platformWholeFieldKeys, platformWholeFieldSource, platformFieldPageStartRead,
  type PlatformFieldReadBinding, type PlatformReadIdentity } from "./platform-read-handle-registry";

export type PlatformPublishedFieldRecord = { source: string; id: string; fields: Record<string, unknown> };
export type PlatformWholeFieldStatus = "read" | "not_recorded" | "field_too_large" | "version_changed"
  | "not_found_in_scope" | "not_published" | "permission_denied" | "query_error";
export type PlatformWholeFieldRead = {
  schemaVersion: "platform-field-read.v1"; status: PlatformWholeFieldStatus;
  source: string; id: string; observedAt: string; parentContentHash?: string;
  fields: Array<{ fieldKey: string; value: unknown; valueHash: string; complete: true }>;
  fieldAvailability: Record<string, string>;
  coverage: { fieldComplete: boolean; rawRecordComplete: false };
  rawRead?: { source: string; id: string; offset: 0; expectedHash: string };
  nextRead?: ReturnType<typeof platformFieldPageStartRead>;
  representation: "whole_published_field";
  scope: "authenticated_owner_exact_source";
  warning: string;
  observation?: { kind: "live_read" | "frozen_capture"; observedAt: string };
};
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
export function platformPublishedRecordHash(record: PlatformPublishedFieldRecord) {
  return digest(JSON.stringify({ source: record.source, id: record.id, fields: record.fields }));
}

/** Host-only context. Model parameters cannot request or authorize this expansion. */
export type PlatformRelatedChatTitleSubject = PlatformReadIdentity & { source: "chat"; id: string; fieldKey: "title" };
export type PlatformRelatedChatTitleContext = {
  originalQuestion: string; registry: PlatformReadHandleRegistry; identity: PlatformReadIdentity;
  budget: ReturnType<typeof createMemoryReadBudget>; signal?: AbortSignal;
  authorize?: (binding: PlatformFieldReadBinding) => Promise<boolean>;
  /** Pre-query access decision; no unknown or parent-substituted child hash. */
  authorizeSubject?: (subject: PlatformRelatedChatTitleSubject) => Promise<boolean>;
  /** Optional adapter rejection guard; never overrides native identity, hash or owner checks. */
  verifyParentRelation?: (parent: PlatformPublishedFieldRecord) => boolean;
  observation?: { kind: "live_read" | "frozen_capture"; observedAt: string };
};
export type PlatformRelatedChatTitleRead = {
  schemaVersion: "platform-related-chat-title.v1";
  status: PlatformWholeFieldStatus | "invalid_relation" | "budget_unavailable" | "not_repeated";
  parent: { source: string; id: string; contentHash: string };
  child?: { source: "chat"; id: string };
  authorizationChecks: Array<"owner_predicate" | "allowed" | "denied" | "subject_authorization_required">;
  reads: Array<{ stage: "chat_title" | "parent_recheck"; source: string; id: string;
    status: string; attemptCharged: boolean; queryAttempted: boolean }>;
  fieldRead?: PlatformWholeFieldRead;
  budgetAccounting: "nested_attempts_and_formatted_results_outer_result_also_charged";
  warning: string;
};
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export function strictPublishedMessageChatId(fields: Record<string, unknown>): string | null {
  const aliases = ["chatId", "chat_id"].flatMap(key => {
    const descriptor = Object.getOwnPropertyDescriptor(fields, key);
    return descriptor ? [descriptor] : [];
  });
  if (!aliases.length || aliases.some(descriptor => !("value" in descriptor)
    || typeof descriptor.value !== "string" || !uuid.test(descriptor.value))) return null;
  const values = aliases.map(descriptor => (descriptor.value as string).toLowerCase());
  return values.every(value => value === values[0]) ? values[0] : null;
}

/** One declared child read plus one relation recheck; every query spends the existing read budget. */
export async function readPlatformRelatedChatTitle(input: {
  userId: string; parent: PlatformPublishedFieldRecord; parentContentHash: string;
  context: PlatformRelatedChatTitleContext;
}, readRecord: (subject: { source: string; id: string }) => Promise<PlatformPublishedFieldRecord | null>): Promise<PlatformRelatedChatTitleRead | undefined> {
  const { parent, context } = input;
  const plan = selectPlatformAnswerContract(context.originalQuestion);
  if (platformWholeFieldSource(parent.source) !== "message" || plan?.subject?.source !== "message"
    || plan.subject.id !== parent.id.toLowerCase()
    || !plan.requirements.some(requirement => requirement.source === "chat" && requirement.fieldKey === "title" && requirement.linkedBy === "chatId")) return undefined;
  context.signal?.throwIfAborted();
  const base: PlatformRelatedChatTitleRead = { schemaVersion: "platform-related-chat-title.v1", status: "invalid_relation",
    parent: { source: parent.source, id: parent.id, contentHash: input.parentContentHash }, reads: [], authorizationChecks: [],
    budgetAccounting: "nested_attempts_and_formatted_results_outer_result_also_charged",
    warning: "This controlled expansion reads only one owner-visible chat title and rechecks the message relation. Each extra read uses the existing budget; the outer formatted result is also charged. It does not inspect other messages or establish a user decision." };
  if (context.identity.ownerId !== input.userId || context.identity.requester.kind !== "chat") return { ...base, status: "permission_denied" };
  try { context.registry.assertIdentity(context.identity); } catch { return { ...base, status: "permission_denied" }; }
  if (!uuid.test(parent.id) || !Object.hasOwn(parent.fields, "id") || parent.fields.id !== parent.id
    || platformPublishedRecordHash(parent) !== input.parentContentHash) return base;
  const chatId = strictPublishedMessageChatId(parent.fields);
  if (!chatId || (context.verifyParentRelation && !context.verifyParentRelation(parent))) return base;
  base.child = { source: "chat", id: chatId };
  const gap = (status: PlatformWholeFieldStatus, reason: string, field?: PlatformWholeFieldRead): PlatformRelatedChatTitleRead => ({
    ...base, status, fieldRead: field ? { ...field, status, fields: [], coverage: { fieldComplete: false, rawRecordComplete: false },
      fieldAvailability: { title: reason } } : {
      schemaVersion: "platform-field-read.v1", status, source: "chat", id: chatId,
      observedAt: context.observation?.observedAt ?? new Date().toISOString(), ...(context.observation ? { observation: { ...context.observation } } : {}),
      fields: [], fieldAvailability: { title: reason }, coverage: { fieldComplete: false, rawRecordComplete: false },
      representation: "whole_published_field", scope: "authenticated_owner_exact_source", warning: base.warning,
    } });
  let stage: "chat_title" | "parent_recheck" = "chat_title";
  let queryAttempted = false;
  const subjectAccess = async () => {
    context.signal?.throwIfAborted(); context.registry.assertIdentity(context.identity);
    if (!context.authorizeSubject) {
      if (context.authorize) { base.authorizationChecks.push("subject_authorization_required"); return false; }
      base.authorizationChecks.push("owner_predicate"); return true;
    }
    const allowed = await context.authorizeSubject({ ...context.identity, requester: { ...context.identity.requester }, source: "chat", id: chatId, fieldKey: "title" });
    context.signal?.throwIfAborted(); context.registry.assertIdentity(context.identity);
    base.authorizationChecks.push(allowed ? "allowed" : "denied");
    return allowed;
  };
  const run = async <T>(current: typeof stage, subject: { source: string; id: string }, action: (markQuery: () => void) => Promise<T>): Promise<T> => {
    stage = current; queryAttempted = false;
    const before = context.budget.snapshot().attempts;
    const wrapped = context.budget.wrap([{ name: "platformRecall", description: "Fixed host-associated field read; not a public tool parameter.",
      parameters: Type.Object({}), execute: async () => {
        context.signal?.throwIfAborted(); context.registry.assertIdentity(context.identity);
        const result = await action(() => { queryAttempted = true; });
        context.signal?.throwIfAborted(); context.registry.assertIdentity(context.identity);
        return result;
      }, formatResult: result => JSON.stringify(result) }])[0];
    try {
      const result = await wrapped.execute({ internalRead: "message_chat_title.v1", stage: current,
        source: subject.source, id: subject.id, parentSource: parent.source, parentId: parent.id, parentContentHash: input.parentContentHash },
      { toolCallId: `related:${parent.id}:${current}`, signal: context.signal }) as T;
      base.reads.push({ stage: current, ...subject, status: typeof result === "object" && result && "status" in result ? String(result.status) : "read",
        attemptCharged: context.budget.snapshot().attempts > before, queryAttempted });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      base.reads.push({ stage: current, ...subject, status: message.startsWith("memory_read_not_repeated:") ? "not_repeated"
        : /^memory_read_(?:budget_exhausted|output_over_budget):/.test(message) ? "budget_unavailable" : "query_error",
        attemptCharged: context.budget.snapshot().attempts > before, queryAttempted });
      throw error;
    }
  };
  try {
    const field = await run("chat_title", base.child, async markQuery => {
      if (!await subjectAccess()) return gap("permission_denied", "related_subject_authorization_denied_or_unavailable").fieldRead!;
      markQuery();
      const record = await readRecord(base.child!);
      if (!record) return gap("not_found_in_scope", "not_found_in_scope").fieldRead!;
      if (record.source !== "chat" || record.id !== chatId || !Object.hasOwn(record.fields, "id") || record.fields.id !== chatId
        || !Object.hasOwn(record.fields, "title") || (record.fields.title !== null && typeof record.fields.title !== "string"))
        return gap("not_published", "invalid_chat_identity_or_title").fieldRead!;
      const handle = context.registry.register({ source: "chat", id: chatId, fieldKey: "title", contentHash: platformPublishedRecordHash(record) });
      return readPlatformWholeField({ registry: context.registry, identity: context.identity, readHandle: handle.readHandle,
        signal: context.signal, observation: context.observation, authorize: context.authorize }, async () => record);
    });
    if (field.status !== "read" && field.status !== "not_recorded") return { ...base, status: field.status, fieldRead: field };
    const recheck = await run("parent_recheck", { source: parent.source, id: parent.id }, async markQuery => {
      markQuery();
      const current = await readRecord({ source: parent.source, id: parent.id });
      if (!current) return { status: "not_found_in_scope" as const };
      if (current.source !== parent.source || current.id !== parent.id || !Object.hasOwn(current.fields, "id") || current.fields.id !== parent.id)
        return { status: "query_error" as const };
      const currentHash = platformPublishedRecordHash(current);
      return { status: currentHash === input.parentContentHash && strictPublishedMessageChatId(current.fields) === chatId
        && (!context.verifyParentRelation || context.verifyParentRelation(current)) ? "read" as const : "version_changed" as const,
        source: parent.source, id: parent.id, contentHash: currentHash };
    });
    if (recheck.status !== "read") return gap(recheck.status, "parent_relation_recheck_failed", field);
    if (!await subjectAccess()) return gap("permission_denied", "related_subject_authorization_no_longer_allowed", field);
    context.signal?.throwIfAborted();
    context.registry.assertIdentity(context.identity);
    return { ...base, status: field.status, fieldRead: field };
  } catch (error) {
    context.signal?.throwIfAborted();
    try { context.registry.assertIdentity(context.identity); } catch { return gap("permission_denied", "turn_identity_no_longer_valid"); }
    if (error instanceof Error && error.message.startsWith("memory_read_not_repeated:")) return { ...gap("query_error", "related_read_not_repeated"), status: "not_repeated" };
    if (error instanceof Error && /^memory_read_(?:budget_exhausted|output_over_budget):/.test(error.message)) return { ...gap("query_error", "related_read_budget_unavailable"), status: "budget_unavailable" };
    return gap("query_error", `${stage}_failed`);
  }
}
const snake = (field: string) => field.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
function fieldValue(record: PlatformPublishedFieldRecord, key: string): { available: boolean; value?: unknown; reason?: string } {
  const alias = snake(key);
  const own = Object.hasOwn(record.fields, key), other = alias !== key && Object.hasOwn(record.fields, alias);
  if (own && other && JSON.stringify(record.fields[key]) !== JSON.stringify(record.fields[alias])) return { available: false, reason: "conflicting_aliases" };
  if (key !== "textParts") return { available: own || other, value: own ? record.fields[key] : record.fields[alias] };
  const parts = record.fields.parts;
  if (!Array.isArray(parts)) return { available: parts === null, value: null, reason: parts === undefined ? "missing" : "uninterpreted_parts" };
  const known = new Set(["text", "reasoning", "tool-native", "tool-call", "tool-result", "tool_use", "tool_result", "image", "file"]);
  if (parts.some(part => !part || typeof part !== "object" || Array.isArray(part) || !known.has(part.type)
    || (part.type === "text" && typeof part.text !== "string"))) return { available: false, reason: "uninterpreted_parts" };
  return { available: true, value: parts.flatMap((part, index) => part.type === "text" ? [{ index, text: part.text }] : [])
    .map((part, textIndex) => ({ ...part, textIndex })) };
}

/** Reader callbacks repeat current authorization and return only their fixed published owner projection. */
export async function readPlatformWholeField(input: {
  readHandle: string; registry: PlatformReadHandleRegistry; identity: PlatformReadIdentity;
  authorize?: (binding: PlatformFieldReadBinding) => Promise<boolean>;
  observation?: { kind: "live_read" | "frozen_capture"; observedAt: string };
  signal?: AbortSignal;
}, readRecord: (binding: PlatformFieldReadBinding) => Promise<PlatformPublishedFieldRecord | null>): Promise<PlatformWholeFieldRead> {
  input.signal?.throwIfAborted();
  const binding = input.registry.resolve(input.readHandle, input.identity);
  if (input.observation && !Number.isFinite(Date.parse(input.observation.observedAt))) throw Error("Invalid platform field observation time");
  const base: PlatformWholeFieldRead = { schemaVersion: "platform-field-read.v1", status: "query_error",
    source: binding.source, id: binding.id, observedAt: input.observation?.observedAt ?? new Date().toISOString(),
    ...(input.observation ? { observation: { ...input.observation } } : {}), fields: [], fieldAvailability: {},
    coverage: { fieldComplete: false, rawRecordComplete: false }, representation: "whole_published_field", scope: "authenticated_owner_exact_source",
    warning: "A complete field is not a complete raw record, business acceptance or independent claim verification. Non-text message payloads remain unread." };
  // The native gateway currently supports owner chat only. A Work identity needs
  // a separately authorized reader, never an implicit owner-console upgrade.
  if (binding.requester.kind !== "chat" && !input.authorize) return { ...base, status: "permission_denied" };
  const access = async () => {
    if (!input.authorize) return true;
    try { return await input.authorize({ ...binding, requester: { ...binding.requester } }) === true; }
    catch { input.signal?.throwIfAborted(); return false; }
  };
  const finalAccess = async () => {
    input.signal?.throwIfAborted();
    try { input.registry.resolve(input.readHandle, input.identity); } catch { return false; }
    if (!await access()) return false;
    input.signal?.throwIfAborted();
    try { input.registry.resolve(input.readHandle, input.identity); } catch { return false; }
    return true;
  };
  try {
    if (!await access()) return { ...base, status: "permission_denied" };
    try { input.registry.resolve(input.readHandle, input.identity); } catch { return { ...base, status: "permission_denied" }; }
    input.signal?.throwIfAborted();
    const record = await readRecord(binding);
    input.signal?.throwIfAborted();
    try { input.registry.resolve(input.readHandle, input.identity); } catch { return { ...base, status: "permission_denied" }; }
    // All source reads, hashing and serialization finish before the final release guard.
    const prepare = (): PlatformWholeFieldRead => {
      if (!record) return { ...base, status: "not_found_in_scope" };
      if (record.source !== binding.source || record.id !== binding.id || !record.fields || typeof record.fields !== "object" || Array.isArray(record.fields)) return base;
      const parentContentHash = platformPublishedRecordHash(record);
      const rawRead = { source: binding.source, id: binding.id, offset: 0 as const, expectedHash: parentContentHash };
      const versioned = { ...base, parentContentHash, rawRead };
      if (parentContentHash !== binding.contentHash) return { ...versioned, status: "version_changed" };
      const selected = fieldValue(record, binding.fieldKey);
      if (!selected.available || selected.value === undefined) return { ...versioned, status: "not_published", fieldAvailability: { [binding.fieldKey]: selected.reason ?? "missing" } };
      const encoded = JSON.stringify(selected.value);
      if (encoded === undefined) return base;
      // Return the exact JSON wire value, detached from getters and toJSON callbacks.
      const value: unknown = JSON.parse(encoded), valueHash = digest(encoded);
      const result: PlatformWholeFieldRead = { ...versioned, status: value === null ? "not_recorded" : "read",
        fields: [{ fieldKey: binding.fieldKey, value, valueHash, complete: true }],
        fieldAvailability: { [binding.fieldKey]: value === null ? "not_recorded" : "shown" }, coverage: { fieldComplete: true, rawRecordComplete: false } };
      if (JSON.stringify(result).length > 8000) {
        const nextRead = platformFieldPageStartRead(binding, input.readHandle);
        return { ...versioned, status: "field_too_large", fieldAvailability: { [binding.fieldKey]: "present_unread" }, ...(nextRead ? { nextRead } : {}) };
      }
      return result;
    };
    const result = prepare();
    if (!await finalAccess()) return { ...base, status: "permission_denied" };
    return result;
  } catch (error) {
    input.signal?.throwIfAborted();
    if (!await finalAccess()) return { ...base, status: "permission_denied" };
    // No database error text, partial values or continuation metadata enter a gap.
    return base;
  }
}

/** Read data descriptors without executing metadata accessors or proxy traps. */
function metadataDescriptors(value: unknown): Record<string, PropertyDescriptor> | undefined {
  if (!value || typeof value !== "object" || isProxy(value) || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== "string")
    || Object.values(descriptors).some(entry => !("value" in entry) || entry.enumerable !== true)) return undefined;
  return descriptors;
}
function metadataArray(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value) || isProxy(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Array.prototype && prototype !== null) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value as object), length = descriptors.length;
  if (!length || !("value" in length) || !Number.isSafeInteger(length.value) || length.value < 0 || length.value > 256
    || Reflect.ownKeys(descriptors).length !== length.value + 1) return undefined;
  const copied: unknown[] = [];
  for (let index = 0; index < length.value; index++) {
    const entry = descriptors[String(index)];
    if (!entry || !("value" in entry) || entry.enumerable !== true) return undefined;
    copied.push(entry.value);
  }
  return copied;
}
const optionalRunScalarKeys = ["triggerReason", "startedAt", "completedAt"];
const fixedRunFactKeys = ["id", "loopId", "status", "error", "triggerReason", "outputSummary", "startedAt", "completedAt", "createdAt"];

/** Suppression applies only to consistent host metadata. It commits no source fact. */
function hostUnpublishedRunFieldKeys(value: Record<string, unknown>, source: string, id: string, contentHash: string): Set<string> {
  const empty = () => new Set<string>(), envelope = metadataDescriptors(value);
  if (source !== "loopRuns" || !envelope) return empty();
  const packet = metadataDescriptors(envelope.publishedFacts?.value);
  if (!packet || packet.schemaVersion?.value !== "platform-published-record-facts.v2"
    || packet.source?.value !== source || packet.id?.value !== id || packet.parentContentHash?.value !== contentHash
    || packet.coverage?.value !== "fixed_whole_fields_only" || packet.rawRecordComplete?.value !== false) return empty();
  const packetKeys = ["schemaVersion", "source", "id", "parentContentHash", "fields", "coverage", "rawRecordComplete"];
  if (Object.keys(packet).length !== packetKeys.length || Object.keys(packet).some(key => !packetKeys.includes(key))) return empty();
  const specification = platformPublishedRecordFactSchema(packet.schemaVersion.value);
  if (!specification) return empty();
  const rows = metadataArray(packet.fields?.value);
  if (!rows || rows.length !== fixedRunFactKeys.length) return empty();
  const raw = envelope.fields ? metadataDescriptors(envelope.fields.value) : undefined;
  const availability = envelope.fieldAvailability ? metadataDescriptors(envelope.fieldAvailability.value) : undefined;
  const omitted = envelope.omittedFields ? metadataArray(envelope.omittedFields.value) : undefined;
  if (envelope.fields && !raw || envelope.fieldAvailability && !availability || envelope.omittedFields && !omitted) return empty();
  if (raw?.id && raw.id.value !== id || omitted?.some(key => typeof key !== "string")) return empty();
  const seen = new Set<string>(), unpublished = new Set<string>(), wireFields: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    const field = metadataDescriptors(row), key = field?.fieldKey?.value;
    if (!field || typeof key !== "string" || !fixedRunFactKeys.includes(key) || seen.has(key)) return empty();
    seen.add(key);
    const status = field.status?.value, complete = field.complete?.value;
    if (typeof status !== "string") return empty();
    const fieldKeys = status === "read" || status === "not_recorded"
      ? ["fieldKey", "status", "value", "valueHash", "complete"] : ["fieldKey", "status", "complete"];
    if (Object.keys(field).length !== fieldKeys.length || Object.keys(field).some(name => !fieldKeys.includes(name))) return empty();
    const alias = snake(key), rawDescriptors = [raw?.[key], ...(alias !== key ? [raw?.[alias]] : [])].filter(Boolean) as PropertyDescriptor[];
    if (status === "read" || status === "not_recorded") {
      if (complete !== true || !field.value || !field.valueHash || typeof field.valueHash.value !== "string"
        || status !== (field.value.value === null ? "not_recorded" : "read")) return empty();
      const validated = validatePlatformPublishedFactValue({ schemaVersion: packet.schemaVersion.value, source, fieldKey: key, value: field.value.value });
      if (validated.status !== "valid" || digest(validated.encoded) !== field.valueHash.value) return empty();
      for (const descriptor of rawDescriptors) {
        const original = validatePlatformPublishedFactValue({ schemaVersion: packet.schemaVersion.value, source, fieldKey: key, value: descriptor.value });
        if (original.status !== "valid" || original.encoded !== validated.encoded) return empty();
      }
      if (key === "id" && field.value.value !== id) return empty();
      wireFields.push({ fieldKey: key, status, value: JSON.parse(validated.encoded), valueHash: field.valueHash.value, complete: true });
    } else {
      if (!["not_present", "invalid", "field_too_large", "withheld"].includes(status)
        || complete !== false || field.value || field.valueHash || key === "id") return empty();
      if (status === "not_present") {
        if (rawDescriptors.length || availability && (Object.hasOwn(availability, key) || Object.hasOwn(availability, alias))
          || omitted?.includes(key) || omitted?.includes(alias)) return empty();
        if (optionalRunScalarKeys.includes(key)) unpublished.add(key);
      }
      wireFields.push({ fieldKey: key, status, complete: false });
    }
  }
  // Serialize only checked grammar and detached validated values, never the untrusted packet.
  const encodedPacket = JSON.stringify({ schemaVersion: packet.schemaVersion.value, source, id, parentContentHash: contentHash,
    fields: wireFields, coverage: "fixed_whole_fields_only", rawRecordComplete: false });
  return encodedPacket.length <= specification.maxPacketUTF16 ? unpublished : empty();
}

/** A bounded discovery envelope declares keys, rather than source absence or SDK coverage. */
function hostUnpublishedDiscoveryRunFieldKeys(value: Record<string, unknown>, source: string, id: string, contentHash: string): Set<string> {
  const empty = () => new Set<string>(), envelope = metadataDescriptors(value);
  if (source !== "loopRuns" || !envelope || envelope.representation?.value !== "bounded_projection"
    || envelope.coverage?.value !== "published_source_fields_only" || Object.hasOwn(envelope, "publishedFacts")) return empty();
  const shown = metadataDescriptors(envelope.fields?.value), declared = metadataDescriptors(envelope.fieldAvailability?.value);
  const request = metadataDescriptors(envelope.read?.value), omitted = metadataArray(envelope.omittedFields?.value);
  if (!shown || !declared || !request || !omitted || Object.keys(request).length !== 4
    || request.source?.value !== source || request.id?.value !== id || request.offset?.value !== 0 || request.expectedHash?.value !== contentHash
    || shown.id?.value !== id || declared.id?.value !== "shown") return empty();
  if (omitted.some(key => typeof key !== "string" || !key || Object.hasOwn(shown, key)) || new Set(omitted).size !== omitted.length) return empty();
  const published = new Set([...Object.keys(shown), ...omitted as string[]]), declaredKeys = Object.keys(declared);
  if (published.size !== declaredKeys.length || declaredKeys.some(key => !published.has(key))) return empty();
  for (const key of declaredKeys) {
    const status = declared[key].value;
    if (Object.hasOwn(shown, key)) {
      const observed = shown[key].value;
      if (typeof observed === "object" && observed !== null && isProxy(observed)) return empty();
      let expected: string;
      if (observed === undefined) return empty();
      else if (observed === null) expected = "not_recorded";
      else if (observed === "") expected = "empty_string";
      else if (Array.isArray(observed)) {
        const elements = metadataArray(observed);
        if (!elements) return empty();
        expected = elements.length ? "shown" : "empty_array";
      } else if (typeof observed === "object" && !(observed instanceof Date)) {
        const properties = metadataDescriptors(observed);
        if (!properties) return empty();
        expected = Object.keys(properties).length ? "shown" : "empty_object";
      } else expected = "shown";
      if (status !== expected) return empty();
    } else if (status !== "present_unread" && status !== "not_recorded") return empty();
  }
  return new Set(optionalRunScalarKeys.filter(key => !published.has(key) && !published.has(snake(key))));
}
/** Decorate existing published evidence only. This never reads another source. */
export function attachPlatformReadHandlesToResult<T>(result: T, registry: PlatformReadHandleRegistry): T {
  const visit = (value: unknown, depth: number): unknown => {
    if (!value || typeof value !== "object" || depth > 8) return value;
    if (Array.isArray(value)) return value.map(item => visit(item, depth + 1));
    const original = value as Record<string, unknown>;
    // Decide hint suppression before any decoration can invoke a self-mutating accessor.
    const host = metadataDescriptors(original), hostSource = host?.source?.value, hostId = host?.id?.value;
    const hostRead = metadataDescriptors(host?.read?.value);
    const hostHash = typeof host?.contentHash?.value === "string" ? host.contentHash.value
      : typeof hostRead?.expectedHash?.value === "string" ? hostRead.expectedHash.value : undefined;
    const metadataUnpublished = host && typeof hostSource === "string" && typeof hostId === "string" && hostHash
      ? new Set([...hostUnpublishedRunFieldKeys(original, hostSource, hostId, hostHash),
        ...hostUnpublishedDiscoveryRunFieldKeys(original, hostSource, hostId, hostHash)]) : new Set<string>();
    // Published field values are source bytes, even if a value resembles a
    // record. Decorate the evidence envelope, never embedded source payloads.
    const copy = Object.fromEntries(Object.entries(original).map(([key, item]) => [key, ["text", "fields"].includes(key) ? item : visit(item, depth + 1)]));
    const source = original.source, id = original.id;
    if (typeof source !== "string" || typeof id !== "string" || !platformWholeFieldKeys(source).length
      || (original.status !== undefined && original.status !== "read") || (typeof original.offset === "number" && original.offset !== 0)
      || original.schemaVersion === "platform-field-read.v1") return copy;
    const read = original.read as { expectedHash?: unknown } | undefined;
    let contentHash = typeof original.contentHash === "string" ? original.contentHash
      : typeof read?.expectedHash === "string" ? read.expectedHash : undefined;
    if (!contentHash && original.fields && typeof original.fields === "object" && !Array.isArray(original.fields)
      && original.representation !== "bounded_projection") {
      contentHash = platformPublishedRecordHash({ source, id, fields: original.fields as Record<string, unknown> });
    }
    if (contentHash) {
      const readHandles = [], readHandleGaps = [];
      const unpublished = source === hostSource && id === hostId && contentHash === hostHash
        ? metadataUnpublished : new Set<string>();
      for (const fieldKey of platformWholeFieldKeys(source)) {
        if (unpublished.has(fieldKey)) continue;
        try { readHandles.push(registry.register({ source, id, fieldKey, contentHash })); }
        catch { readHandleGaps.push({ fieldKey, reason: "handle_registration_unavailable" }); }
      }
      // Successful registrations remain visible in their original field order.
      // The fixed capacity, closing and validation failures remain explicit.
      if (readHandles.length) copy.readHandles = readHandles;
      if (readHandleGaps.length) { copy.readHandleGap = "handle_registration_unavailable"; copy.readHandleGaps = readHandleGaps; }
    }
    return copy;
  };
  const decorated = visit(result, 0) as T;
  // Legacy recall.text is the actual model-facing envelope. Keep its handles in
  // sync without adding private details or altering any source raw content.
  if (decorated && typeof decorated === "object" && "text" in decorated && typeof (decorated as { text: unknown }).text === "string") {
    try { (decorated as { text: string }).text = JSON.stringify(visit(JSON.parse((decorated as { text: string }).text), 0)); } catch { /* Non-JSON text remains unchanged. */ }
  }
  return decorated;
}
