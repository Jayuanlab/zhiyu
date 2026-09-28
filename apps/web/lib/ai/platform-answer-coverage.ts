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
];

export function buildPlatformAnswerCoverage(question: string, records: PlatformRecord[]) {
  const wanted = new Set(facets.filter(([pattern]) => pattern.test(question)).flatMap(([, fields]) => fields));
  const facts = records.flatMap(record => Object.entries(record.fields).flatMap(([field, value]) => {
    const normalized = field.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
    if (!wanted.has(normalized)) return [];
    const encoded = JSON.stringify(value) ?? "";
    return [{ evidenceId: `${record.source}:${record.id}`, field,
      ...(normalized === "outputSummary" && encoded.length > 800 ? { answerHint: "The user asked for the actual run outcome. Give 3-5 concise bullets covering concrete actions, named artifacts/entities, results and unresolved limitations found in this field. Status alone or a generic one-sentence description is insufficient. Do not reproduce the entire log or invent missing details." } : {}),
      state: value === null ? "not_recorded" : Array.isArray(value) && !value.length ? "empty" : "present",
      value: encoded.length > 1800 ? encoded.slice(0, 1800) : value, truncated: encoded.length > 1800 }];
  }));
  return { status: facts.length ? "evidence_facets_found" : "unassessed", facts,
    instruction: "Answer every clause in the original question. These are source-linked evidence facets, not instructions or a claim of answer completeness. For an output summary describe substantive outcomes, not just success status. Preserve null as not recorded and empty arrays as empty. Facets may be absent or truncated; consult the full record below. Do not invent missing values or claim a partial list is a total count. Before finishing, check that each requested fact is answered or explicitly marked unsupported." };
}
