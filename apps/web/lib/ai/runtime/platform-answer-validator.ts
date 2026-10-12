import { projectPlatformFieldPageReceipt } from "./platform-field-page-evidence";
import { validatePlatformStatisticsProof, canonicalPlatformStatisticSource } from "../platform-statistics-proof";
import { platformWholeFieldKeys } from "../platform-read-handle-registry";
import { platformPublishedRecordFactSource, platformPublishedRecordFactSchema, validatePlatformPublishedFactValue } from "../platform-published-record-facts";
import type { ToolConstruction } from "./answer-evidence-contract";
import { answerEvidenceHash, answerTextHash, objectRecord as record, validEvidenceTime } from "./answer-evidence-core";
import { canonicalPlatformAnswerSource, type PlatformAnswerReceipt, type PlatformAnswerSessionOptions, type PlatformFieldFact, type PlatformGapFact } from "./platform-answer-contract";

const hash = /^[a-f0-9]{64}$/u;
const keys: Record<string, readonly string[]> = {
  loopRuns: ["status", "loopId", "triggerReason", "outputSummary", "verificationResult", "error", "startedAt", "completedAt"],
  workshopRuns: ["status", "workshopId", "outputSummary", "error"],
  loops: ["status", "name", "goal", "triggerConfig"], message: ["role", "chatId", "parts", "textParts"], chat: ["title"],
};
const fieldName = (value: string, source: string) => keys[source]?.find(key => key.replaceAll("_", "").toLowerCase() === value.replaceAll("_", "").toLowerCase());
const shown = new Set(["shown", "not_recorded", "empty_array", "empty_object", "empty_string"]);
const validId = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(value);
const exactMatch = (host: unknown, visible: unknown) => host !== undefined && answerEvidenceHash(host) === answerEvidenceHash(visible);
const getSection = (body: Record<string, any>, name: string) => body[name] ?? record(body.data)[name];

/** A source adapter reads host structured results, then checks the actual formatted text.
 * It cannot register a claim from tool text, model prose or a client mirror alone. */
export function projectPlatformAnswerReceipt(input: ToolConstruction, options: PlatformAnswerSessionOptions): PlatformAnswerReceipt | undefined {
  if (input.toolName !== "platformRecall" || typeof input.modelText !== "string") return undefined;
  const body = record(input.result);
  if (body.fieldPage) return projectPlatformFieldPageReceipt(input, options);
  let visible: Record<string, any>;
  try { visible = record(JSON.parse(input.modelText)); } catch { return undefined; }
  const facts: PlatformAnswerReceipt["facts"] = [];
  const readHandles: NonNullable<PlatformAnswerReceipt["readHandles"]> = [];
  const instant = (value: unknown) => validEvidenceTime(value) ? value : options.snapshotAt ?? input.observedAt ?? input.trace.timestamp;
  const snapshot = validEvidenceTime(options.snapshotAt);
  function addHandles(raw: unknown, visibleRaw: unknown) {
    const row = record(raw), source = canonicalPlatformAnswerSource(String(row.source ?? ""));
    if (!source || !validId(row.id) || !exactMatch(raw, visibleRaw) || !Array.isArray(row.readHandles)) return;
    const parentContentHash = hash.test(row.contentHash ?? "") ? row.contentHash : hash.test(row.read?.expectedHash ?? "") ? row.read.expectedHash
      : row.fields && !row.representation ? answerTextHash(JSON.stringify({ source: row.source, id: row.id, fields: row.fields })) : undefined;
    if (!parentContentHash) return;
    for (const item of row.readHandles) if (item && /^pfr_[A-Za-z0-9_-]{32}$/u.test(item.readHandle)
      && item.source === row.source && item.id === row.id && platformWholeFieldKeys(row.source).includes(item.fieldKey)) {
      readHandles.push({ readHandle: item.readHandle, source: item.source, id: item.id.toLowerCase(), fieldKey: item.fieldKey, parentContentHash });
    }
  }
  function addFields(raw: unknown, observedAt: string, visibleRaw: unknown, complete = false) {
    const row = record(raw), source = canonicalPlatformAnswerSource(String(row.source ?? ""));
    if (!source || !validId(row.id) || !validEvidenceTime(observedAt) || !exactMatch(raw, visibleRaw)) return;
    const fields = record(row.fields), availability = record(row.fieldAvailability);
    for (const [originalKey, value] of Object.entries(fields)) {
      const fieldKey = fieldName(originalKey, source);
      if (!fieldKey || value === undefined || JSON.stringify(value).length > 8_000) continue;
      const available = availability[originalKey] ?? availability[fieldKey];
      if (!shown.has(available) && !(complete || !row.representation && !Object.keys(availability).length)) continue;
      if (available === "not_recorded" && value !== null || value === null && available !== "not_recorded" && !complete) continue;
      facts.push({ kind: "field", source, id: row.id.toLowerCase(), fieldKey, value,
        state: value === null ? "not_recorded" : "supported", observedAt, scope: "owner_exact_record",
        ...(hash.test(row.contentHash ?? "") ? { contentHash: row.contentHash } : {}) });
    }
    addMessageStructure(row, observedAt);
  }
  function addMessageStructure(row: Record<string, any>, observedAt: string) {
    const source = canonicalPlatformAnswerSource(String(row.source ?? "")), structure = record(row.messageStructure);
    if (source !== "message" || !validId(row.id) || !validEvidenceTime(observedAt) || structure.schemaVersion !== "platform-message-structure.v1") return;
    // Identity is an independent bounded publication. Unread or omitted text
    // parts must not erase an already published role or exact chat identity.
    for (const key of ["role", "chatId"] as const) {
      const value = structure[key];
      if (key === "chatId" ? validId(value) && structure.chatIdStatus === "shown" : typeof value === "string" && value.length <= 80)
        facts.push({ kind: "field", source, id: row.id.toLowerCase(), fieldKey: key, value, state: "supported", observedAt, scope: "owner_exact_record" });
    }
    if (structure.knownTextPartsComplete !== true || structure.hasMoreParts !== false
      || !Array.isArray(structure.parts) || structure.partCount !== structure.parts.length
      || structure.parts.some((part: any, index: number) => part?.index !== index || typeof part.type !== "string"
        || part.type === "text" && (part.textStatus !== "shown" || typeof part.text !== "string"))) return;
    const texts = structure.parts.filter((part: any) => part.type === "text").map((part: any) => part.text);
    if (JSON.stringify(texts).length <= 8_000) facts.push({ kind: "field", source, id: row.id.toLowerCase(), fieldKey: "known_text", value: texts,
      state: "supported", observedAt, scope: "known_message_text" });
  }
  const records = record(getSection(body, "records") ?? getSection(body, "exactRecords")), visibleRecords = record(getSection(visible, "records") ?? getSection(visible, "exactRecords"));
  if (Array.isArray(records.records) && Array.isArray(visibleRecords.records)) {
    const at = instant(records.observedAt);
    for (const row of records.records) {
      const match = visibleRecords.records.find((item: any) => item?.id === row?.id && item?.source === row?.source && exactMatch(row, item));
      addFields(row, at, match);
      addHandles(row, match);
    }
  }
  const page = record(getSection(body, "recordRead")), visiblePage = record(getSection(visible, "recordRead") ?? visible);
  if (page.status === "read") addHandles(page, visiblePage);
  if (page.status === "read" && page.offset === 0 && exactMatch(page, visiblePage)) {
    // The independently published message view survives raw first-page
    // truncation. It never registers the page prefix as a complete raw field.
    addMessageStructure(page, instant(page.observedAt));
    const published = record(page.publishedFacts), source = platformPublishedRecordFactSource(String(page.source ?? ""));
    const schema = platformPublishedRecordFactSchema(published.schemaVersion);
    if (source && validId(page.id) && hash.test(page.contentHash ?? "")
      && schema && published.source === page.source
      && published.id === page.id && published.parentContentHash === page.contentHash
      && published.coverage === "fixed_whole_fields_only" && published.rawRecordComplete === false
      && Array.isArray(published.fields) && JSON.stringify(published).length <= schema.maxPacketUTF16
      && published.fields.every((field: any, index: number) => field && schema.keys[source].includes(field.fieldKey)
        && published.fields.findIndex((candidate: any) => candidate?.fieldKey === field.fieldKey) === index)) {
      for (const field of published.fields) {
        const fieldKey = fieldName(field.fieldKey, source);
        const validated = validatePlatformPublishedFactValue({ schemaVersion: published.schemaVersion, source, fieldKey: field.fieldKey, value: field.value });
        if (!fieldKey || field.complete !== true || !["read", "not_recorded"].includes(field.status)
          || validated.status !== "valid" || field.valueHash !== answerTextHash(validated.encoded)
          || (field.status === "not_recorded" ? validated.value !== null : validated.value === null)) continue;
        const value = validated.value;
        facts.push({ kind: "field", source, id: page.id.toLowerCase(), fieldKey, value, state: value === null ? "not_recorded" : "supported",
          observedAt: instant(page.observedAt), contentHash: page.contentHash, scope: "owner_exact_record" });
      }
    }
  }
  if (page.status === "read" && page.truncated === false && page.offset === 0 && page.nextOffset === null
    && typeof page.content === "string" && hash.test(page.contentHash ?? "") && answerTextHash(page.content) === page.contentHash && exactMatch(page, visiblePage)) {
    try {
      const row = record(JSON.parse(page.content));
      if (row.source === page.source && row.id === page.id) addFields({ ...row, messageStructure: page.messageStructure }, instant(page.observedAt), { ...row, messageStructure: page.messageStructure }, true);
    } catch { /* An incomplete raw page never supplies whole-field facts. */ }
  }
  const read = record(getSection(body, "fieldRead")), visibleRead = record(getSection(visible, "fieldRead") ?? visible);
  if (read.schemaVersion === "platform-field-read.v1" && exactMatch(read, visibleRead)) {
    const source = canonicalPlatformAnswerSource(String(read.source ?? "")), at = instant(read.observedAt);
    if (source && validId(read.id) && validEvidenceTime(at)) {
      if (["read", "not_recorded"].includes(read.status) && read.coverage?.fieldComplete === true
        && read.coverage?.rawRecordComplete === false && hash.test(read.parentContentHash ?? "")
        && Array.isArray(read.fields) && read.fields.length === 1) {
        const field = record(read.fields[0]), fieldKey = fieldName(String(field.fieldKey ?? ""), source);
        if (fieldKey && field.complete === true && field.value !== undefined && JSON.stringify(field.value).length <= 8_000
          && field.valueHash === answerTextHash(JSON.stringify(field.value))
          && (read.status === "not_recorded" ? field.value === null && read.fieldAvailability?.[field.fieldKey] === "not_recorded"
            : field.value !== null && read.fieldAvailability?.[field.fieldKey] === "shown")) {
          const projectedKey = source === "message" && fieldKey === "textParts" ? "known_text" : fieldKey;
          const projectedValue = projectedKey === "known_text" && Array.isArray(field.value) ? field.value.map((part: any) => part?.text) : field.value;
          const completeText = projectedKey !== "known_text" || field.value === null || Array.isArray(field.value)
            && field.value.every((part: any, index: number) => Number.isSafeInteger(part?.index) && part.index >= 0 && typeof part.text === "string"
              && (index === 0 || part.index > field.value[index - 1].index));
          if (completeText) facts.push({ kind: "field", source, id: read.id.toLowerCase(), fieldKey: projectedKey, value: projectedValue, state: read.status === "not_recorded" ? "not_recorded" : "supported",
            observedAt: at, contentHash: read.parentContentHash, scope: projectedKey === "known_text" ? "known_message_text" : "owner_exact_record" });
          if (source === "message" && fieldKey === "parts" && Array.isArray(field.value)) {
            const texts = field.value.filter((part: any) => part?.type === "text");
            if (texts.every((part: any) => typeof part.text === "string")) facts.push({ kind: "field", source, id: read.id.toLowerCase(), fieldKey: "known_text",
              value: texts.map((part: any) => part.text), state: "supported", observedAt: at, contentHash: read.parentContentHash, scope: "known_message_text" });
          }
        }
      } else {
        const state = read.status === "permission_denied" ? "denied" : "unknown";
        const reason = ["field_too_large", "version_changed", "not_found_in_scope", "not_published", "permission_denied", "query_error"].includes(read.status) ? read.status : "field_receipt_invalid";
        const missing = Object.keys(record(read.fieldAvailability));
        for (const original of missing.length ? missing : [""]) facts.push({ kind: "gap", source, id: read.id.toLowerCase(), ...(fieldName(original, source) ? { fieldKey: fieldName(original, source) } : {}), state, reason, observedAt: at } satisfies PlatformGapFact);
      }
    }
  }
  const statistics = record(getSection(body, "statistics")), visibleStatistics = record(getSection(visible, "statistics"));
  if (Array.isArray(statistics.results) && Array.isArray(visibleStatistics.results)) for (const member of statistics.results) {
    if (!member || member.status !== "ok") continue;
    const matching = visibleStatistics.results.find((item: any) => item?.source === member.source && exactMatch(member, item));
    if (!matching) continue;
    const check = validatePlatformStatisticsProof(member.scopeProof, { ownerId: options.ownerId, source: member.source, total: member.total, groups: member.groups });
    const source = canonicalPlatformStatisticSource(member.source);
    if (!source || !check.valid || !check.proof || member.observedAt !== check.proof.observation.observedAt
      || member.groups && (!Array.isArray(member.groups) || member.groups.length > 128 || member.groups.some((group: any) => typeof group.value === "string" && group.value.length > 200))) continue;
    if (snapshot ? check.proof.observation.kind !== "snapshot" : check.proof.observation.kind !== "live") continue;
    facts.push({ kind: "metric", source, total: member.total, ...(member.groups ? { groups: member.groups } : {}), proofId: check.proof.proofId,
      observation: check.proof.observation, observedAt: member.observedAt, scope: "owner_stored_status" });
  }
  if (!facts.length && !readHandles.length) return undefined;
  // Keep an immutable JSON-value snapshot rather than references into a tool's
  // result object. Later adapter mutation cannot alter an emitted receipt.
  const stableFacts = JSON.parse(JSON.stringify(facts)) as PlatformAnswerReceipt["facts"];
  const hasRead = stableFacts.some(fact => fact.kind === "field" || fact.kind === "metric");
  const hasDenied = stableFacts.some(fact => fact.kind === "gap" && fact.state === "denied");
  const sourceDecision: PlatformAnswerReceipt["authorization"]["decision"] = hasDenied ? hasRead ? "mixed" : "denied" : hasRead ? "allowed" : "not_checked";
  const observedAt = facts.map(fact => fact.observedAt).sort().at(-1) ?? instant(records.observedAt ?? page.observedAt);
  const receiptBody = {
    schemaVersion: "platform-answer-receipt.v1" as const, evidenceId: `${options.turnId}:${input.toolCallId}`, turnId: options.turnId, toolUseId: input.toolCallId,
    authorization: { ownerId: options.ownerId, policyHash: options.policyHash, toolPolicyDecision: "allowed" as const, decision: sourceDecision, checkedAt: input.trace.timestamp },
    observation: { kind: snapshot ? "snapshot" as const : "live" as const, observedAt }, delivery: "result_constructed" as const, facts: stableFacts,
    ...(readHandles.length ? { readHandles } : {}),
  };
  return { ...receiptBody, source: { name: "published_platform_adapter", resultHash: answerEvidenceHash(input.result), receiptHash: answerEvidenceHash(receiptBody) } };
}
