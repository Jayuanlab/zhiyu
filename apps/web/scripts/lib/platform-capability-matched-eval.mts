import { createHash } from "node:crypto";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { PlatformCapabilityContext, PlatformCapabilityRoutingResult } from "../../lib/ai/platform-capability-routing";
import { createGuardedPiTool } from "../../lib/ai/runtime/pi-tool-adapter";
import type { RuntimeToolPolicy, RuntimeToolTraceEvent } from "../../lib/ai/runtime/tool-executor";

export type MatchedCase = {
  id: string; group: string; question: string; context?: PlatformCapabilityContext;
  expectedIds?: string[]; expectedIdAlternatives?: string[][];
  expectNoNetwork?: boolean; expectJevAttempt?: boolean; main?: boolean;
  mainEvidenceTools?: string[]; answerPatterns?: string[];
};
export type MatchedFixture = {
  schemaVersion: "platform-capability-matched-fixture.v1";
  suiteVersion: string; frozenAt: string; sourcePolicy: string;
  snapshot: {
    asOf: string;
    document: { id: string; fileName: string; content: string; totalChunks: number };
    memoryStatistics: { total: number; active: number; candidate: number; rejected: number };
    contacts: Array<{ id: string; name: string }>;
    workshop: { id: string; name: string; mission: string; configuredStatus: string; observedExecutorStatus: string; boundary: string };
    tasks: Array<{ id: string; name: string; status: string }>;
    lastRun: { status: string; outputSummary: string };
  };
  cases: MatchedCase[];
};

export function hash(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

export function extractNativeReadonlyNames(routeSource: string) {
  const block = routeSource.match(/const NATIVE_PI_READ_ONLY_TOOL_NAMES = new Set<NativePiWebChatToolName>\(\[([\s\S]*?)\]\);/)?.[1];
  if (!block) throw Error("readonly_contract_not_found");
  const names = [...block.matchAll(/"([A-Za-z][A-Za-z0-9]+)"/g)].map(item => item[1]);
  if (!names.length || new Set(names).size !== names.length) throw Error("invalid_readonly_contract");
  return names;
}

export function validateFixture(value: unknown): asserts value is MatchedFixture {
  const fixture = value as MatchedFixture;
  if (fixture?.schemaVersion !== "platform-capability-matched-fixture.v1" || !Array.isArray(fixture.cases)
    || fixture.cases.length < 12 || fixture.cases.length > 18 || new Set(fixture.cases.map(item => item.id)).size !== fixture.cases.length
    || !fixture.snapshot?.document?.content || !fixture.snapshot?.contacts || !fixture.sourcePolicy) throw Error("invalid_fixture");
  for (const item of fixture.cases) {
    const alternatives = item.expectedIdAlternatives ?? (item.expectedIds ? [item.expectedIds] : undefined);
    if (!/^CAP-\d{2}$/.test(item.id) || !item.question || !alternatives?.length
      || alternatives.some(ids => !Array.isArray(ids) || new Set(ids).size !== ids.length || ids.some(id => typeof id !== "string" || !id))
      || item.context && JSON.stringify(item.context).length > 2000) throw Error("invalid_fixture_case");
  }
  if (fixture.cases.filter(item => item.expectJevAttempt).length < 2 || fixture.cases.filter(item => item.main).length < 6
    || fixture.cases.filter(item => item.main).length > 8) throw Error("insufficient_matched_cases");
}

export function gradeRouting(item: MatchedCase, result: PlatformCapabilityRoutingResult, networkCalls: number) {
  const alternatives = item.expectedIdAlternatives ?? [item.expectedIds ?? []];
  const actual = [...result.capabilityIds].sort();
  const expectedEmpty = alternatives.every(ids => ids.length === 0);
  const exact = alternatives.some(ids => JSON.stringify([...ids].sort()) === JSON.stringify(actual));
  const acceptable = result.status === "ok" && actual.length > 0 && exact;
  const wrongSelection = actual.length > 0 && !acceptable;
  const abstained = actual.length === 0;
  return {
    accepted: actual.length > 0, acceptable, wrongSelection, abstained,
    correctEmpty: expectedEmpty && abstained && result.status !== "degraded",
    unresolvedPositive: !expectedEmpty && abstained,
    degraded: result.status === "degraded",
    unexpectedNetwork: Boolean(item.expectNoNetwork && networkCalls),
    expectedJevAttempt: Boolean(item.expectJevAttempt),
    jevAttemptObserved: networkCalls > 0,
    objectiveMatch: !wrongSelection && (acceptable || expectedEmpty && abstained && result.status !== "degraded") && !(item.expectNoNetwork && networkCalls),
  };
}

export function gradeMain(item: MatchedCase, answer: string, toolNames: string[], completed: boolean, businessUnavailable: number) {
  const evidenceObserved = (item.mainEvidenceTools ?? []).some(name => toolNames.includes(name));
  const answerChecks = (item.answerPatterns ?? []).map(pattern => ({ pattern, matched: new RegExp(pattern, "is").test(answer) }));
  return { completed, evidenceObserved, answerChecks, businessUnavailable,
    checkedFactsSupported: completed && evidenceObserved && answerChecks.length > 0 && answerChecks.every(check => check.matched) && businessUnavailable === 0,
    qualityScope: "Frozen explicit fact patterns and expected source use only; no model judge and no overall answer-quality score." };
}

export function appendAdvisory(prompt: string, result: PlatformCapabilityRoutingResult) {
  if (result.status !== "ok" || !result.capabilityIds.length) return prompt;
  return prompt + "\n\n[Advisory platform capability matches: " + JSON.stringify(result.capabilityIds)
    + ". Inspect their actual parameter schemas. Ignore a suggestion that does not fit the owner's request. "
    + "This does not execute any action, supply missing arguments, authorize writes or establish success. Existing guards and bound owner commands remain required.]";
}

export function replayPrompt(item: MatchedCase, snapshot: MatchedFixture["snapshot"]) {
  return "You are answering a read-only platform evaluation against a fixed, synthetic source snapshot. "
    + "Use mounted guarded readers for factual platform data. Do not execute writes, send messages, read external URLs or invent records. "
    + "A completed tool receipt is not business success. Report missing data explicitly. Answer in Chinese, briefly, and retain requested distinctions. "
    + "The snapshot is synthetic, not current production state. Its asOf is " + snapshot.asOf
    + (item.context ? "\nHost-confirmed evaluation context: " + JSON.stringify(item.context) : "")
    + "\n\n" + item.question;
}

function replayResult(name: string, params: Record<string, any>, snapshot: MatchedFixture["snapshot"], question: string) {
  const evidence = { provider: "frozen_synthetic_replay", asOf: snapshot.asOf, productionFacts: false };
  const doc = snapshot.document;
  if (name === "listKnowledgeBaseDocuments") return { ...evidence, ok: true, count: 1, returnedCount: 1,
    documents: [{ id: doc.id, fileName: doc.fileName, totalChunks: doc.totalChunks }], text: JSON.stringify({ count: 1, documents: [{ id: doc.id, fileName: doc.fileName }] }) };
  if (name === "getFullDocumentContent") {
    if (params.documentId !== doc.id) return { ...evidence, ok: false, isError: true, status: "unavailable", warning: "document_not_in_frozen_snapshot" };
    return { ...evidence, ok: true, text: doc.content, data: { documentId: doc.id, documentName: doc.fileName,
      content: doc.content, contentHash: hash(doc.content), totalChunks: 1, nextOffset: null, complete: true } };
  }
  if (name === "searchKnowledgeBase") return { ...evidence, ok: true, text: doc.content,
    results: [{ documentId: doc.id, documentName: doc.fileName, content: doc.content, source: "knowledge" }], count: 1 };
  if (name === "queryContacts") return { ...evidence, ok: true, count: snapshot.contacts.length, total: snapshot.contacts.length,
    contacts: snapshot.contacts, text: JSON.stringify({ total: snapshot.contacts.length, contacts: snapshot.contacts }) };
  if (["inspectWorkshopAgent", "describeWorkshop", "discoverWorkshops"].includes(name)) return { ...evidence, ok: true,
    workshop: snapshot.workshop, workshops: [snapshot.workshop], configuredStatus: snapshot.workshop.configuredStatus,
    observedExecutorStatus: snapshot.workshop.observedExecutorStatus, warning: "configuration_status_is_not_executor_observation" };
  if (name === "observeWorkshop") return { ...evidence, ok: true, observedExecutorStatus: "unknown", lastRun: snapshot.lastRun,
    warning: "last_completed_run_does_not_prove_current_executor" };
  if (name === "listLoopTasks") return { ...evidence, ok: true, loops: snapshot.tasks, tasks: snapshot.tasks, count: snapshot.tasks.length };
  if (name === "platformRecall") {
    if (/记忆|memory/i.test(question)) return { ...evidence, ok: true, status: "complete", statistics: { memory: snapshot.memoryStatistics },
      text: JSON.stringify({ memoryStatistics: snapshot.memoryStatistics, scope: "complete_frozen_population" }) };
    if (/工程控制论|研究材料|知识库|文档/i.test(question)) return { ...evidence, ok: true, status: "complete", knowledge: [doc], text: doc.content };
    if (/车间|职责|边界/i.test(question)) return { ...evidence, ok: true, status: "complete", workshop: snapshot.workshop, lastRun: snapshot.lastRun };
    if (/任务|loop/i.test(question)) return { ...evidence, ok: true, status: "complete", loops: snapshot.tasks };
  }
  // An unsupported replay adapter is explicit missing evidence, never invented success.
  return { ...evidence, ok: false, status: "unavailable", warning: "reader_not_bound_in_this_frozen_replay", toolName: name };
}

export function createReplayTools(input: {
  actualTools: readonly AgentTool<any>[]; snapshot: MatchedFixture["snapshot"]; item: MatchedCase;
  policy: RuntimeToolPolicy; onTrace?: (trace: RuntimeToolTraceEvent) => void;
  onReplay?: (event: { toolName: string; paramsHash: string; resultHash: string; unavailable: boolean }) => void;
}) {
  return input.actualTools.map(tool => createGuardedPiTool({ name: tool.name, label: tool.label,
    description: tool.description, parameters: tool.parameters, policy: input.policy, onTrace: input.onTrace,
    execute: params => {
      const result = replayResult(tool.name, params as Record<string, any>, input.snapshot, input.item.question);
      input.onReplay?.({ toolName: tool.name, paramsHash: hash(JSON.stringify(params)), resultHash: hash(JSON.stringify(result)),
        unavailable: result.ok === false });
      return result;
    }, formatResult: result => JSON.stringify(result) }));
}

/** Every attempt is counted before dispatch, including failed requests and SDK retries. */
export function createPaidCallBudget(limit = 40) {
  let calls = 0;
  const records: Array<{ ordinal: number; provider: "jev" | "main"; caseId: string; arm: string; at: string }> = [];
  return { reserve(provider: "jev" | "main", caseId: string, arm: string) {
    if (calls >= limit) throw Error("paid_call_limit");
    records.push({ ordinal: ++calls, provider, caseId, arm, at: new Date().toISOString() });
  }, snapshot: () => ({ limit, calls, remaining: limit - calls, records: [...records] }) };
}

export async function readProviderPayload(input: RequestInfo | URL, init?: RequestInit) {
  const body = typeof init?.body === "string" ? init.body : input instanceof Request ? await input.clone().text() : undefined;
  if (!body) throw Error("provider_payload_unobservable");
  try { return JSON.parse(body); } catch { throw Error("provider_payload_invalid_json"); }
}

export function verifyProviderOutputLimit(payload: any, limit = 2048) {
  const configured = payload.max_tokens ?? payload.max_completion_tokens ?? payload.max_output_tokens;
  if (!Number.isSafeInteger(configured) || configured <= 0 || configured > limit) throw Error("provider_output_limit_invalid");
  return configured as number;
}

export function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const center = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[center] : (sorted[center - 1] + sorted[center]) / 2;
}
