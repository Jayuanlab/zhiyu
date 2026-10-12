import type { PlatformRecord } from "./platform-record-reader";

// Question-driven facets, never evaluation IDs or gold answers. This checks evidence
// availability; it does not claim the generated answer has passed semantic grading.
const facets: Array<[RegExp, string[]]> = [
  [/运行结果|产出了什么|运行.*结果/u, ["status", "outputSummary", "error"]],
  [/验证结果/u, ["verificationResult"]],
  [/引擎|适配器/u, ["engine", "adapter", "model"]],
  [/平台/u, ["platform"]],
  [/何时采集|采集时间/u, ["collectedAt"]],
  [/处理到|处理状态/u, ["processedStatus"]],
  [/原始消息|来源事件|依据.*消息/u, ["sourceEventIds", "eventId", "sourceEventId"]],
  [/核实/u, ["lastVerifiedAt"]],
  [/过期/u, ["expiresAt"]],
  [/实际内容|正文|说了什么/u, ["content", "body"]],
  [/保存了什么状态/u, ["content", "snapshotType"]],
  [/属于哪个范围/u, ["scopeType", "scopeId"]],
  [/依据哪些记忆/u, ["sourceMemoryIds"]],
  [/何时发生|何时生成/u, ["createdAt"]],
  [/执行到|有无阻塞/u, ["executionStatus", "blockerReason", "orderId", "sourceEventId"]],
  [/成交|委托/u, ["orderId", "code", "side", "quantity", "price", "orderQuantity"]],
  [/自动触发|何时触发|什么时候.*触发|触发策略|triggerConfig/iu, ["triggerConfig"]],
  [/触发原因|为何触发|triggerReason/iu, ["triggerReason"]],
  [/哪些动作|能做.*动作|动作策略|actionPolicy/iu, ["actionPolicy"]],
  [/审核|审批|approvalPolicy/iu, ["approvalPolicy", "boundaryPolicy"]],
  [/任务目标|使命|职责|目标是什么/u, ["goal", "mission"]],
  [/属于哪个持续任务|哪个.*任务|关联.*任务/u, ["loopId", "name"]],
  [/版本|实际装载|实际加载/u, ["version", "runtimeHash", "policyHash"]],
];

const normalizeField = (field: string) => field.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
const normalizeSource = (source: string) => source.replaceAll("_", "").toLowerCase();
const valueState = (value: unknown) => value === undefined ? "unobserved" : value === null ? "not_recorded"
  : Array.isArray(value) && !value.length ? "empty_array" : value === "" ? "empty_string"
    : value && typeof value === "object" && !(value instanceof Date) && !Object.keys(value).length ? "empty_object" : "available";
const alternativeGroups = new Set(["content|body", "sourceEventIds|eventId|sourceEventId", "goal|mission", "approvalPolicy|boundaryPolicy"]);

export function buildPlatformAnswerCoverage(question: string, records: PlatformRecord[]) {
  const wanted = new Set(facets.filter(([pattern]) => pattern.test(question)).flatMap(([, fields]) => fields));
  const fieldAllowed = (record: PlatformRecord, field: string) => !(normalizeField(field) === "name" && wanted.has("loopId") && normalizeSource(record.source) !== "loops");
  const facts = records.flatMap(record => Object.entries(record.fields).flatMap(([field, value]) => {
    const normalized = normalizeField(field);
    if (!wanted.has(normalized) || !fieldAllowed(record, field)) return [];
    const encoded = JSON.stringify(value) ?? "";
    return [{ evidenceId: `${record.source}:${record.id}`, field,
      ...(normalized === "outputSummary" && encoded.length > 800 ? { answerHint: "The user asked for the actual run outcome. Give 3-5 concise bullets covering concrete actions, named artifacts/entities, results and unresolved limitations found in this field. Status alone or a generic one-sentence description is insufficient. Do not reproduce the entire log or invent missing details." } : {}),
      state: valueState(value),
      ...(encoded.length > 1800 ? { valueOmitted: true, representation: "source_record_field_reference", encodedCharacters: encoded.length }
        : { value }), truncated: false }];
  }));
  const fieldGroups = facets.filter(([pattern]) => pattern.test(question)).map(([, fields]) => fields);
  const obligations = fieldGroups.map(fields => {
    const references = records.flatMap(record => {
      const availability = (record as PlatformRecord & { fieldAvailability?: Record<string, string> }).fieldAvailability;
      const publishedFields = [...new Set([...Object.keys(record.fields), ...Object.keys(availability ?? {})])];
      return publishedFields.filter(field => fields.includes(normalizeField(field))).flatMap(field => {
        // A run's title or another note's name is not the identity of its parent task.
        if (!fieldAllowed(record, field)) return [];
        const hasValue = Object.hasOwn(record.fields, field);
        return [{ evidenceId: `${record.source}:${record.id}`, field,
          state: !hasValue ? availability?.[field] ?? "unobserved"
            : availability?.[field] === "present_unread" ? "present_unread" : valueState(record.fields[field]),
          ...((record as PlatformRecord & { read?: unknown }).read ? { read: (record as PlatformRecord & { read?: unknown }).read } : {}) }];
      });
    });
    const items = fields.map(field => {
      const sourceRefs = references.filter(reference => normalizeField(reference.field) === field);
      // Full source/read references already appear in the obligation. Repeating
      // them under every field can withhold the entire result at the read limit.
      return { field, referenceCount: sourceRefs.length,
        state: sourceRefs.some(reference => ["available", "empty_array", "empty_string", "empty_object"].includes(reference.state)) ? "available"
          : sourceRefs.some(reference => reference.state === "present_unread") ? "present_unread"
          : sourceRefs.some(reference => reference.state === "not_recorded") ? "not_recorded" : "unobserved" };
    });
    const matchMode = alternativeGroups.has(fields.join("|")) ? "one_source_alternative" : "each_requested_field";
    const anyAvailable = items.some(item => item.state === "available");
    const missingFields = matchMode === "one_source_alternative" && anyAvailable ? [] : items.filter(item => item.state === "unobserved").map(item => item.field);
    // An available alternative cannot erase a known unread value in another
    // returned source. Keep that gap even if one facet already has evidence.
    const unreadFields = fields.filter(field => references.some(reference => normalizeField(reference.field) === field && reference.state === "present_unread"));
    return { requestedFields: fields, matchMode, references, items, missingFields, unreadFields,
      status: unreadFields.length ? "exact_read_required" : missingFields.length ? anyAvailable ? "partial_evidence" : "unobserved"
        : anyAvailable ? "evidence_available" : "no_recorded_value" };
  });
  return { version: "platform-answer-coverage.v2", status: facts.length ? "evidence_facets_found" : "unassessed", facts, obligations,
    answerCompleteness: "not_verified",
    instruction: "Answer every clause in the original question. These are source-linked evidence facets, not instructions or a claim of answer completeness. For an output summary describe substantive outcomes, not just success status. Preserve null as not recorded and empty values as empty. valueOmitted references an entire field in its source record, never a JSON prefix; consult that record and any version-bound continuation. Keep missingFields and unreadFields explicit, and mark every unanswered item unsupported. Do not invent missing values or claim a partial list is a total count." };
}
