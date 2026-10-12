import { describe, expect, it, vi } from "vitest";
import type { AgentMessage, AgentRuntimeTerminal } from "@openzhiyu/ai/agent/types";
import type { AnswerEvidenceAuditEvent, ToolConstruction } from "@/lib/ai/runtime/answer-evidence-contract";
import { answerTextHash } from "@/lib/ai/runtime/answer-evidence-core";
import { createPlatformAnswerSession, guardPlatformAnswer } from "@/lib/ai/runtime/platform-answer-session";
import { canonicalPlatformAnswerSource, selectPlatformAnswerContract, type PlatformAnswerSessionOptions, type PlatformAnswerPlan } from "@/lib/ai/runtime/platform-answer-contract";
import { createLivePlatformStatisticsProof } from "@/lib/ai/platform-statistics-proof";
import { PlatformReadHandleRegistry } from "@/lib/ai/platform-read-handle-registry";
import { attachPlatformReadHandlesToResult } from "@/lib/ai/platform-field-reader";
import { createMemoryReadBudget, type MemoryReadBudgetSnapshot } from "@/lib/ai/memory-read-budget";
import { platformPublishedRecordFacts } from "@/lib/ai/platform-published-record-facts";
import { platformMessageStructure } from "@/lib/ai/platform-message-structure";

const id = "11111111-1111-4111-8111-111111111111", linked = "22222222-2222-4222-8222-222222222222", other = "33333333-3333-4333-8333-333333333333";
const at = "2026-10-04T01:00:00.000Z";
const terminal: AgentRuntimeTerminal = { schemaVersion: "agent-runtime-terminal.v1", status: "completed", cleanupStatus: "completed" };
function construction(result: unknown, toolCallId = "read-1", modelText = JSON.stringify(result)): ToolConstruction {
  return { toolCallId, toolName: "platformRecall", params: { question: "status only" }, result, modelText,
    trace: { type: "tool_result", title: "completed", detail: null, toolName: "platformRecall", toolUseId: toolCallId, status: "completed", timestamp: at, durationMs: 1,
      metadata: { decision: "allow", reason: "allowed", matchedRule: "platformRecall", deniedBeforeHandler: false } } };
}
function event(c: ToolConstruction): AgentMessage { return { type: "tool_result", toolUseId: c.toolCallId, output: c.modelText, isError: false, toolResultDetails: { result: c.result, trace: c.trace } }; }
function setup(question = `loopRuns ${id} 的状态和结果是什么？`, overrides: Partial<PlatformAnswerSessionOptions> = {}) {
  const auditSink = vi.fn(async (_event: AnswerEvidenceAuditEvent) => undefined);
  const session = createPlatformAnswerSession({ mode: "enforce_supported", turnId: "turn", ownerId: "owner", runtimeHash: "runtime", policyHash: "policy", question,
    authorizeFinal: async () => true, auditSink, now: () => new Date(at), ...overrides });
  return { session, auditSink };
}
function records(rows: Array<Record<string, unknown>>, extras: Record<string, unknown> = {}) { return { ok: true, data: { records: { observedAt: at, records: rows, ...extras } } }; }
function row(source: string, rowId: string, fields: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { source, id: rowId, fields, fieldAvailability: Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, value === null ? "not_recorded" : "shown"])), ...extra };
}
async function read(session: ReturnType<typeof setup>["session"], c: ToolConstruction) { await session.observeToolConstruction(c); await session.observeToolResult(event(c)); }
async function finish(session: ReturnType<typeof setup>["session"], rawDraft = "success：全部已生效", state = terminal) { return session.finalize({ terminal: state, rawDraft }); }
function field(value: unknown, status = value === null ? "not_recorded" : "read", key = "verificationResult", source = "loopRuns", rowId = id) {
  return { schemaVersion: "platform-field-read.v1", status, source, id: rowId, parentContentHash: "a".repeat(64), observedAt: at,
    fields: ["read", "not_recorded"].includes(status) ? [{ fieldKey: key, value, valueHash: answerTextHash(JSON.stringify(value)), complete: true }] : [],
    fieldAvailability: { [key]: status === "not_recorded" ? "not_recorded" : status === "read" ? "shown" : "present_unread" }, coverage: { fieldComplete: ["read", "not_recorded"].includes(status), rawRecordComplete: false } };
}
function metric(ownerId = "owner", observedAt = at) {
  const groups = [{ value: "active", count: 2 }, { value: null, count: 1 }], total = 3, source = "brainMemories.status";
  return { source, status: "ok", groups, total, observedAt, scopeProof: createLivePlatformStatisticsProof({ ownerId, source, total, groups, observedAt }) };
}
function publishedPage(schemaVersion: string, source: string, fields: Record<string, unknown>) {
  const contentHash = "a".repeat(64);
  return { status: "read", source, id, offset: 0, truncated: true, nextOffset: 100, content: "{raw prefix remains unread", contentHash, observedAt: at,
    publishedFacts: { schemaVersion, source, id, parentContentHash: contentHash, coverage: "fixed_whole_fields_only", rawRecordComplete: false,
      fields: Object.entries(fields).map(([fieldKey, value]) => ({ fieldKey, value, status: value === null ? "not_recorded" : "read", valueHash: answerTextHash(JSON.stringify(value)), complete: true })) } };
}

describe("platform original-question contract", () => {
  it.each([`暂停 Loop ${id}`, `请删除 chat ${id}，然后查标题`, `message ${id} 内容是什么，帮我发送给别人`, `loopRuns ${id} 截至昨天是否成功`, `loopRuns ${id} 和 ${other} 的结果`, "帮我把记忆更新后统计数量", `chat ${id} 标题是什么，并创建新聊天`, `读取 loopRuns ${id} 并删除它`, `chat ${id} 重命名为测试`, `message ${id} 正文是什么，然后点击确认`, `Read chat ${id} and rename it`])("does not claim action, history or multiple records: %s", question => expect(selectPlatformAnswerContract(question)).toBeNull());
  it("preserves all supported facets from the original question, not a tool paraphrase", () => {
    const plan = selectPlatformAnswerContract(`loopRuns ${id} 是什么任务，目标、触发原因、触发配置、结果和验证是什么？`)!;
    expect(plan.requirements.map(item => item.id)).toEqual(expect.arrayContaining(["loopRuns.status", "loopRuns.loopId", "loops.name", "loops.goal", "loopRuns.triggerReason", "loops.triggerConfig", "loopRuns.outputSummary", "loopRuns.verificationResult"]));
  });
  it.each([`loopRuns ${id} 的状态和耗时`, `chat ${id} 标题和参与者`, `loopRuns ${id} 结果和关联车间`, `loopRuns ${id} 结果和审批情况`])("does not silently drop unsupported explicit clauses: %s", question => {
    expect(selectPlatformAnswerContract(question)?.requirements.some(item => item.id === "unassessed_clause")).toBe(true);
  });
  it.each([`message ${id} 的正文与收件人是谁`, `loopRuns ${id} 的结果、地点和负责人`, `chat ${id} 的标题和保密级别`])("preserves an unknown grammar residual instead of declaring the whole question covered: %s", question => {
    expect(selectPlatformAnswerContract(question)?.requirements.some(item => item.id === "unassessed_clause")).toBe(true);
  });
  it.each([`chat ${id} 的标题和角色`, `loops ${id} 的配置是什么`, `chat ${id} 的正文`, "记忆数量和目标"])("does not erase a known field word that belongs to another contract: %s", question => {
    expect(selectPlatformAnswerContract(question)?.requirements.some(item => item.id === "unassessed_clause")).toBe(true);
  });
  it("retains the original question and matches the fixed captured-data wrapper only as metadata", () => {
    const question = `在随题提供的只读数据快照（${at}）中，针对所选关联记录：message ${id} 表达了什么？`;
    const plan = selectPlatformAnswerContract(question)!;
    expect(plan.question).toBe(question); expect(plan.requestedSnapshotAt).toBe(at);
    expect(plan.requirements.map(item => item.id)).toEqual(["message.role", "message.chatId", "message.known_text", "message.interpretation"]);
    expect(selectPlatformAnswerContract(`在其它随题提供的只读数据快照（${at}）中，message ${id} 表达了什么？`)?.requirements.some(item => item.id === "unassessed_clause")).toBe(true);
  });
  it("keeps an unsupported exact raw event separate from owner statistics", () => {
    const plan = selectPlatformAnswerContract(`记忆状态总数是多少，interactionEvents ${id} 原文是什么，是否存在？`)!;
    expect(plan.kind).toBe("stored_status_distribution"); expect(plan.subject).toBeUndefined();
    expect(plan.requirements).toEqual(expect.arrayContaining([expect.objectContaining({ id: "brain_memories.status", facet: "metric" }), expect.objectContaining({ id: "specific_raw_event", subjectId: id, facet: "boundary" })]));
  });
  it.each([`loopRuns ${id} 结果和数量`, `message ${id} 内容和数量`, `chat ${id} 标题和数量`])("does not redirect a supported exact record to statistics: %s", question => {
    const plan = selectPlatformAnswerContract(question)!;
    expect(plan.subject?.id).toBe(id); expect(plan.kind).not.toBe("stored_status_distribution"); expect(plan.requirements.some(item => item.id === "unassessed_clause")).toBe(true);
  });
  it("gives order fills and processing failures specific boundaries without broad residuals", () => {
    const orders = selectPlatformAnswerContract("模拟委托状态各有多少笔，区分委托和实际成交？")!;
    expect(orders.requirements.map(item => item.id)).toEqual(["paper_orders.status", "paper_order_fill_ledger"]);
    const jobs = selectPlatformAnswerContract("当前用户的消息理解作业，等待、完成、失败等状态各有多少个？失败作业不等于消息消失。")!;
    expect(jobs.requirements.filter(item => !item.metricRequest && !item.boundaryKind).map(item => item.id)).toEqual(["interaction_processing_jobs.status", "processing_failure_not_disappearance"]);
    expect(jobs.requirements.filter(item => item.metricRequest).map(item => item.metricRequest?.value)).toEqual(["completed", "failed"]);
    expect(jobs.requirements.some(item => item.boundaryKind === "waiting_definition")).toBe(true);
  });
  it.each(["消息理解作业", "消息理解任务", "理解作业", "加工任务", "加工作业", "处理队列", "处理任务", "处理作业"])("uses the same bounded job vocabulary for the contract: %s", topic => {
    const plan = selectPlatformAnswerContract(`当前用户的${topic}状态各有多少个？`)!;
    expect(plan.ruleVersion).toBe("platform-compact-interpretation.v7"); expect(plan.requirements.map(item => item.id)).toEqual(["interaction_processing_jobs.status"]);
  });
  it("keeps the trigger and both stored instants as separate obligations in a run question", () => {
    const plan = selectPlatformAnswerContract(`运行记录 ${id} 为什么开始？什么时候开始和结束？`)!;
    expect(plan.requirements.map(item => item.fieldKey)).toEqual(expect.arrayContaining(["triggerReason", "startedAt", "completedAt"]));
    const duration = selectPlatformAnswerContract(`运行记录 ${id} 什么时候开始和结束，耗时多久？`)!;
    expect(duration.requirements.some(item => item.id === "unassessed_clause")).toBe(true);
  });
  it("requires interpretation when the original question asks what a message is discussing", () => {
    const plan = selectPlatformAnswerContract(`消息记录 ${id} 在谈什么？`)!;
    expect(plan.requirements.map(item => item.id)).toEqual(expect.arrayContaining(["message.known_text", "message.interpretation"]));
  });
  it("preserves a precise captured raw-message instant without inventing a pending definition", () => {
    const plan = selectPlatformAnswerContract(`截至 ${at} 的随题只读快照，原始交互消息已处理、待处理各有多少条？`)!;
    expect(plan.requestedSnapshotAt).toBe(at);
    expect(plan.statisticSources).toEqual(["interaction_events.processed_status"]);
    expect(plan.requirements.filter(item => item.metricRequest).map(item => item.metricRequest?.value)).toEqual(["processed"]);
    expect(plan.requirements.some(item => item.boundaryKind === "waiting_definition")).toBe(true);
    expect(selectPlatformAnswerContract("截至昨天，原始消息已处理有多少条？")).toBeNull();
  });
  it("publishes text coordinates independently of unread reasoning and tool-part coordinates", () => {
    const structure = platformMessageStructure("message", { role: "assistant", parts: [
      { type: "reasoning", text: "unread reasoning" }, { type: "text", text: "first text" },
      { type: "tool-result", output: "unread output" }, { type: "text", text: "second text" },
    ] }, { source: "message", id, offset: 0, expectedHash: "a".repeat(64) })!;
    expect(structure.parts.filter(part => part.type === "text").map(part => ({ index: part.index, textIndex: part.textIndex })))
      .toEqual([{ index: 1, textIndex: 0 }, { index: 3, textIndex: 1 }]);
    expect(structure.knownTextPartsComplete).toBe(true); expect(structure.rawRecordComplete).toBe(false);
    expect(JSON.stringify(structure)).not.toContain("unread output");
  });
  it("does not turn an exact archived message noun into a history requirement or erase the decision boundary", () => {
    const plan = selectPlatformAnswerContract(`message ${id} 这条实际历史聊天消息出自哪个聊天，角色是什么，它表达了什么，是否为用户已经作出的决定？`)!;
    expect(plan.requirements.map(item => item.id)).toEqual(["message.role", "message.chatId", "message.known_text", "message.interpretation", "chat.title", "original_user_decision"]);
    expect(selectPlatformAnswerContract(`message ${id} 截至昨天的历史聊天消息，角色是什么？`)).toBeNull();
    expect(selectPlatformAnswerContract(`message ${id} 历史聊天消息表达了什么，收件人是谁？`)?.requirements.some(item => item.id === "unassessed_clause")).toBe(true);
    const wrapped = `在随题提供的只读数据快照（${at}）中，针对所选关联记录：这条历史聊天消息表达了什么，出自哪个聊天、哪个角色？它是否明确包含用户已经作出的决定？\n对象：Message_v2（记录 ${id}）`;
    expect(selectPlatformAnswerContract(wrapped)?.requirements.map(item => item.id)).toEqual(["message.role", "message.chatId", "message.known_text", "message.interpretation", "chat.title", "original_user_decision"]);
  });
  it("treats lifecycle status as a stored grouping dimension while preserving effective-count and actual-history boundaries", () => {
    const plan = selectPlatformAnswerContract("记忆各生命周期状态各有多少条，哪些数量不能当作当前有效记忆量？")!;
    expect(plan.requirements.map(item => item.id)).toEqual(["brain_memories.status", "business_effective_count"]);
    expect(selectPlatformAnswerContract("记忆历史生命周期变化和状态总数")?.requirements.some(item => item.id === "source_lifecycle_history")).toBe(true);
    expect(selectPlatformAnswerContract("记忆生命周期状态总数与负责人")?.requirements.some(item => item.id === "unassessed_clause")).toBe(true);
    const wrapped = `在随题提供的只读数据快照（${at}）中，当前用户的记忆中，各生命周期状态各有多少条？哪些数量不能当作当前有效记忆量？`;
    expect(selectPlatformAnswerContract(wrapped)?.requirements.map(item => item.id)).toEqual(["brain_memories.status", "business_effective_count"]);
  });
});
describe("platform explicit object source boundary", () => {
  const objectQuestion = (body: string, source: string, recordId = id) => `${body}\n对象：${source}（记录 ${recordId}）`;

  it.each(["work_run_diagnostics", "workshop_runs", "workshop_events"])("does not redirect an explicit unsupported %s object through a nearby run noun", source => {
    const question = objectQuestion("这次运行诊断列出哪些失败类别和根因候选？依据的证据包是否完整？", source);
    expect(selectPlatformAnswerContract(question)).toBeNull();
  });
  it.each([
    ["loop_runs", "loopRuns", "这次运行的状态、结果和验证是什么？"],
    ["LoopRuns", "loopRuns", "这次运行的状态和结果是什么？"],
    ["loops", "loops", "所选持续任务的目标和配置状态是什么？"],
    ["message", "message", "这条消息的角色和正文是什么？"],
    ["Message_v2", "message", "这条历史聊天消息表达了什么，出自哪个聊天、哪个角色？"],
    ["messagev2", "message", "这条消息的角色和正文是什么？"],
    ["chat_messages", "message", "这条消息的角色和正文是什么？"],
    ["chatMessages", "message", "这条消息的角色和正文是什么？"],
    ["chat", "chat", "所选对话的标题是什么？"],
  ])("selects only the fixed canonical alias %s", (alias, source, body) => {
    const question = objectQuestion(body, alias);
    const plan = selectPlatformAnswerContract(question)!;
    expect(canonicalPlatformAnswerSource(alias)).toBe(source);
    expect(plan.subject).toEqual({ source, id }); expect(plan.question).toBe(question);
  });
  it.each(["loop__runs", "message___v2", "chat_message", "loopRuns.status", "车间运行诊断", "“普通持续任务名称”"])("does not infer another contract from an unknown object name %s", source => {
    expect(selectPlatformAnswerContract(objectQuestion("这次运行的状态和结果是什么？", source))).toBeNull();
  });
  it.each([
    objectQuestion(`loopRuns ${id} 的状态和结果是什么？`, "Message_v2"),
    objectQuestion(`message ${id} 的角色和正文是什么？`, "loop_runs"),
    objectQuestion(`loopRuns ${id} 的状态是什么？`, "loops"),
    objectQuestion(`loopRuns ${other} 的状态是什么？`, "loop_runs"),
    objectQuestion(`loopRuns ${id} 与 loops ${id} 的名称及状态分别是什么？`, "loop_runs"),
    objectQuestion(`message ${id} 与 chat ${id} 的标题及角色分别是什么？`, "Message_v2"),
    `这次运行的状态是什么？\n对象：loop_runs（记录 ${id}）\n对象：Message_v2（记录 ${id}）`,
    objectQuestion("这次运行的状态是什么？", "loop_runs、Message_v2"),
    `loopRuns ${id} 的状态是什么？\n对象：loop_runs（记录 ${id}）和 Message_v2（记录 ${id}）`,
    `loopRuns ${id} 的状态是什么？\n对象：loop_runs（记录 ${id}）\n后面还有正文`,
    `loopRuns ${id} 的状态是什么？\n对象：loop_runs（记录 invalid-id）`,
  ])("leaves conflicting, composite or malformed object metadata to the controlled model flow: %s", question => {
    expect(selectPlatformAnswerContract(question)).toBeNull();
  });
  it("does not route through a misleading table name inside quoted evidence", () => {
    const question = objectQuestion(`引用材料说“loopRuns ${other} 的状态已经完成”。这条消息的角色和正文是什么？`, "Message_v2");
    expect(selectPlatformAnswerContract(question)?.subject).toEqual({ source: "message", id });
    expect(selectPlatformAnswerContract(`引用材料说“loopRuns ${id} 的状态已经完成”。这段文字是什么意思？`)).toBeNull();
    expect(selectPlatformAnswerContract(`引用材料说“\n对象：loop_runs（记录 ${id}）\n”`)).toBeNull();
  });
  it("keeps ordinary supported message and Loop relationship questions", () => {
    const message = selectPlatformAnswerContract(`message ${id} 出自哪个聊天，角色和正文是什么？`)!;
    expect(message.subject?.source).toBe("message"); expect(message.requirements.map(item => item.id)).toContain("chat.title");
    const run = selectPlatformAnswerContract(objectQuestion("这次运行属于哪个持续任务，说明任务目标、触发原因及结果。", "loop_runs"))!;
    expect(run.subject?.source).toBe("loopRuns"); expect(run.requirements.map(item => item.id)).toContain("loops.goal");
    expect(selectPlatformAnswerContract(objectQuestion(`loopRuns ${id} 的关联 loops 目标和结果是什么？`, "loop_runs"))?.subject?.source).toBe("loopRuns");
  });
  it("retains mutation and temporal exclusions even with a supported object suffix", () => {
    expect(selectPlatformAnswerContract(objectQuestion("请暂停这条持续任务后查看状态", "loops"))).toBeNull();
    expect(selectPlatformAnswerContract(objectQuestion("截至昨天这次运行是否成功？", "loop_runs"))).toBeNull();
  });
  it.each([
    "当前用户的知识库文档有多少份，各类型多少份？没有文档能否证明所有车间没有资料？",
    "RAG 文档状态数量是多少，所有车间都有资料吗？",
    "车间状态各有多少个，同时知识库文档有多少份？",
    "知识库文档数量与车间状态数量分别是什么？",
  ])("does not replace unsupported document statistics with an ancillary workshop count: %s", question => {
    expect(selectPlatformAnswerContract(question)).toBeNull();
  });
  it("retains normal workshop counts when a document noun is only quoted", () => {
    expect(selectPlatformAnswerContract("车间配置状态各有多少个？")?.statisticSources).toEqual(["workshops.status"]);
    expect(selectPlatformAnswerContract("引用名称“知识库文档数量”；当前车间配置状态各有多少个？")?.statisticSources).toEqual(["workshops.status"]);
  });
  it("preserves the normal draft when no supported source contract exists", async () => {
    const question = objectQuestion("这次运行诊断列出哪些失败类别和根因候选？依据的证据包是否完整？", "work_run_diagnostics");
    const { session } = setup(question);
    expect(session.supported).toBe(false);
    const draft = "失败类别是来源不足；根因仅是候选；证据包尚不完整。";
    const decision = await finish(session, draft);
    expect(decision.outcome).toBe("unchecked"); expect(decision.renderedText).toBe(draft);
  });
});

describe("trusted platform facts and final delivery", () => {
  it.each(["model_text", "unregistered_result", "construction", "sdk_context"])("never treats %s as emitted proof", async variant => {
    const { session } = setup(), c = construction(records([row("loopRuns", id, { status: "completed", outputSummary: "原结果" })]));
    if (variant === "model_text") await session.observeToolResult({ type: "text", content: c.modelText });
    else if (variant === "unregistered_result") await session.observeToolResult(event(c));
    else { await session.observeToolConstruction(c); if (variant === "sdk_context") await session.observeContextCommitted({ toolCallId: c.toolCallId, entryId: "sdk-entry", modelText: c.modelText! }); }
    const decision = await finish(session);
    expect(decision.outcome).toBe("unknown"); expect(decision.questionComplete).toBe(false); expect(decision.evidenceRefs).toEqual([]);
    expect(session.snapshot().contextReceiptCount).toBe(variant === "sdk_context" ? 1 : 0);
  });
  it("renders only bound complete fields and keeps raw draft out of enforced text and receipt audit", async () => {
    const { session, auditSink } = setup(); await read(session, construction(records([row("loopRuns", id, { status: "completed", outputSummary: "原结果" })])));
    const decision = await finish(session, "错误结论：已实际发送给客户");
    expect(decision.questionComplete).toBe(true); expect(decision.renderedText).toContain("原结果"); expect(decision.renderedText).not.toContain("已实际发送");
    const receiptStages = auditSink.mock.calls.filter(([item]) => ["observed_server", "evidence_registered"].includes(item.eventType));
    expect(JSON.stringify(receiptStages)).not.toContain("原结果"); expect(JSON.stringify(receiptStages)).toContain("valueHash");
    expect(auditSink.mock.calls.map(([item]) => item.eventType)).toContain("read_phase_closed");
  });
  it("accepts host Date serialization and snapshots values against later result mutation", async () => {
    const { session } = setup(), fields = { status: "completed", outputSummary: { detail: "原值" }, createdAt: new Date(at) };
    const c = construction(records([row("loopRuns", id, fields)])); await read(session, c); fields.outputSummary.detail = "后改值";
    const decision = await finish(session); expect(decision.questionComplete).toBe(true); expect(decision.renderedText).toContain("原值"); expect(decision.renderedText).not.toContain("后改值");
  });
  it("renders source Markdown and backticks as literal data", async () => {
    const { session } = setup(), value = "![track](https://example.invalid/image) `<script>payload</script>`";
    await read(session, construction(records([row("loopRuns", id, { status: "completed", outputSummary: value })])));
    const decision = await finish(session); expect(decision.renderedText).toContain(`\`\` ${JSON.stringify(value)} \`\``);
  });
  it("keeps long and multiline string fields intact and trigger objects as inert JSON", async () => {
    const { session } = setup(`loopRuns ${id} 的结果和触发原因是什么？`);
    const output = "输出第一行\r\n```\n![track](https://example.invalid/image)\n最后一行", reason = { kind: "manual", instruction: "```\n<script>source</script>", details: [null, true] };
    await read(session, construction(records([row("loopRuns", id, { status: "completed", outputSummary: output, triggerReason: reason, error: null })])));
    const decision = await finish(session); expect(decision.renderedText).toContain(`\`\`\`\`text\n${output}\n\`\`\`\``);
    expect(decision.renderedText).toContain(`\`\`\`\`json\n${JSON.stringify(reason, null, 2)}\n\`\`\`\``);
    expect(decision.questionComplete).toBe(true);
  });
  it("withholds an entire field if its safe fence would exhaust the display budget", async () => {
    const { session } = setup(`loopRuns ${id} 的结果、验证和触发原因是什么？`), value = "`".repeat(7200);
    await read(session, construction(records([row("loopRuns", id, { status: "completed", outputSummary: value, verificationResult: value, triggerReason: value, error: null })])));
    const decision = await finish(session);
    expect(decision.resolutions.find(item => item.requirementId === "loopRuns.triggerReason")).toMatchObject({ state: "unknown", reason: "answer_display_budget_exhausted", evidenceIds: [] });
    expect(decision.renderedText.length).toBeLessThan(60_000); expect(decision.questionComplete).toBe(false);
  });
  it("closes a multiline task-goal fence before the current-configuration qualifier", async () => {
    const { session } = setup(`loops ${id} 的目标是什么？`), goal = "目标第一行\n目标第二行";
    await read(session, construction(records([row("loops", id, { status: "active", goal })]))); const decision = await finish(session);
    expect(decision.renderedText).toContain(`\`\`\`text\n${goal}\n\`\`\`\n（读取时任务配置`); expect(decision.questionComplete).toBe(true);
    expect(decision.renderedText).not.toContain("存储的运行状态只描述运行记录");
  });
  it("commits delegated SDK context separately from the outer emitted toolResult", async () => {
    for (const emit of [false, true]) {
      const { session } = setup(), child = construction(records([row("loopRuns", id, { status: "completed", outputSummary: "原值" })]), "outer:child");
      const text = JSON.stringify({ observations: [{ tool: "platformRecall", status: "retrieved", truncated: false, evidence: child.modelText }] });
      const outer = construction({ content: [{ type: "text", text }], details: { delegatedReceipts: [{ ...child, deliveredComplete: true }] } }, "outer", text);
      outer.toolName = "askMemory"; outer.trace = { ...outer.trace, toolName: "askMemory" };
      await session.observeToolConstruction(child); await session.observeToolConstruction(outer);
      await session.observeContextCommitted({ toolCallId: "outer", entryId: "entry", modelText: text });
      expect(session.snapshot()).toMatchObject({ contextReceiptCount: 1, receiptCount: 0 });
      if (emit) await session.observeToolResult(event(outer));
      expect((await finish(session)).questionComplete).toBe(emit);
    }
  });
  it("requires original verification even if a follow-up asks status only", async () => {
    const { session } = setup(`loopRuns ${id} 的状态、结果和验证是什么？`);
    await read(session, construction(records([row("loopRuns", id, { status: "completed", outputSummary: "done" }, { representation: "bounded_projection", fieldAvailability: { status: "shown", outputSummary: "shown", verificationResult: "present_unread" } })])));
    const decision = await finish(session);
    expect(decision.outcome).toBe("partial"); expect(decision.questionComplete).toBe(false);
    expect(decision.resolutions.find(item => item.requirementId === "loopRuns.verificationResult")?.state).toBe("unknown");
  });
  it.each([
    { snapshot: false, status: "success" }, { snapshot: true, status: "success" },
    { snapshot: false, status: "completed" }, { snapshot: true, status: "completed" },
    { snapshot: false, status: "custom_stored_state" }, { snapshot: true, status: "custom_stored_state" },
  ])("names the run-record boundary and preserves fields, sources and verification gaps: %j", async ({ snapshot, status }) => {
    const baseQuestion = `loopRuns ${id} 的状态、结果和验证是什么？`;
    const { session } = setup(snapshot ? `在随题提供的只读数据快照（${at}）中，${baseQuestion}` : baseQuestion,
      snapshot ? { snapshotAt: at, timePolicy: { mode: "unconstrained" } } : {});
    const outputSummary = "原输出保留\n本字段不替代业务验收回执。";
    await read(session, construction(records([row("loopRuns", id, { status, outputSummary }, { representation: "bounded_projection",
      fieldAvailability: { status: "shown", outputSummary: "shown", verificationResult: "present_unread" } })])));
    const decision = await finish(session);
    expect(decision.renderedText).toContain("存储的运行状态只描述运行记录，不证明业务验收通过或业务真实效果");
    expect(decision.renderedText).toContain(JSON.stringify(status)); expect(decision.renderedText).toContain(outputSummary);
    expect(decision.evidenceRefs).toEqual(expect.arrayContaining([expect.objectContaining({ source: "loopRuns", evidenceId: "turn:read-1", observedAt: at })]));
    expect(decision.resolutions.find(item => item.requirementId === "loopRuns.status")?.state).toBe("supported");
    expect(decision.resolutions.find(item => item.requirementId === "loopRuns.verificationResult")?.state).toBe("unknown");
    expect(decision.questionComplete).toBe(false); expect(decision.outcome).toBe("partial");
    if (snapshot) expect(decision.renderedText).toContain(`采集于 ${at} 的只读快照`);
  });
  it("keeps a literal run-field question complete without claiming business acceptance", async () => {
    const { session } = setup(); await read(session, construction(records([row("loopRuns", id, { status: "success", outputSummary: "原输出" })])));
    const decision = await finish(session);
    expect(decision.renderedText).toContain("存储的运行状态只描述运行记录，不证明业务验收通过或业务真实效果");
    expect(decision.questionComplete).toBe(true); expect(decision.resolutions.every(item => item.state === "supported")).toBe(true);
  });
  it("does not treat stored success as business acceptance", async () => {
    const { session } = setup(`loopRuns ${id} 成功生效了吗？`);
    await read(session, construction(records([row("loopRuns", id, { status: "completed", outputSummary: "success", verificationResult: { success: true } })])));
    const decision = await finish(session); expect(decision.outcome).toBe("partial"); expect(decision.questionComplete).toBe(false);
    expect(decision.resolutions.find(item => item.requirementId === "business_or_later_outcome")?.state).toBe("unknown");
    expect(decision.renderedText).toContain("存储的运行状态只描述运行记录，不证明业务验收通过或业务真实效果");
    expect(decision.renderedText).toContain('"success"'); expect(decision.evidenceRefs.some(ref => ref.source === "loopRuns")).toBe(true);
  });
  it("binds related task identity by the actual root loopId and marks it current configuration", async () => {
    const { session } = setup(`loopRuns ${id} 是什么任务，目标是什么？`);
    await read(session, construction(records([row("loopRuns", id, { status: "completed", loopId: linked }), row("loops", other, { name: "诱饵任务", goal: "错误目标" }), row("loops", linked, { name: "真实任务", goal: "真实目标" })])));
    const decision = await finish(session); expect(decision.questionComplete).toBe(true); expect(decision.renderedText).toContain("真实任务"); expect(decision.renderedText).not.toContain("诱饵任务"); expect(decision.renderedText).toContain("不能作为运行当时配置");
  });
  it("passes bound linked subjects into the host final permission recheck", async () => {
    const authorizeFinal = vi.fn(async (_plan: PlatformAnswerPlan) => true), { session } = setup(`message ${id} 属于哪个聊天？`, { authorizeFinal });
    await read(session, construction(records([row("message", id, { role: "assistant", chatId: linked }), row("chat", linked, { title: "标题" })])));
    await finish(session); expect(authorizeFinal.mock.calls[0][0]).toMatchObject({ finalAuthorizationSubjects: [{ source: "message", id }, { source: "chat", id: linked }] });
  });
  it("preserves whole known text without granting full raw-parts coverage or user decision", async () => {
    const { session } = setup(`message ${id} 内容是什么，属于哪个聊天，是我的决定吗，完整消息读完了吗？`);
    const structure = { schemaVersion: "platform-message-structure.v1", knownTextPartsComplete: true, hasMoreParts: false, partCount: 2,
      parts: [{ index: 0, type: "text", textStatus: "shown", text: "消息原文" }, { index: 1, type: "tool-call", payloadStatus: "present_unread" }], rawRecordComplete: false };
    await read(session, construction(records([row("message", id, { role: "assistant", chatId: linked }, { messageStructure: structure }), row("chat", linked, { title: "来源聊天" })])));
    const decision = await finish(session); expect(decision.renderedText).toContain("消息原文"); expect(decision.renderedText).toContain("来源聊天");
    expect(decision.resolutions.find(item => item.requirementId === "message.parts")?.state).toBe("unknown"); expect(decision.questionComplete).toBe(false);
  });
  it("renders each known text part with real line breaks inside a fence that cannot be closed by source text", async () => {
    const { session } = setup(`message ${id} 表达了什么，完整消息读完了吗，是用户的决定吗？`);
    const first = "第一行\n第二行\n```\n![link](https://example.invalid/track)\n<script>source</script>", second = "另一个文本段\n尾行\n";
    await read(session, construction(records([row("message", id, { role: "assistant", chatId: linked })])));
    await read(session, construction({ fieldRead: field([{ index: 0, text: first }, { index: 3, text: second }], "read", "textParts", "message") }, "texts"));
    const decision = await finish(session);
    expect(decision.renderedText).toContain(`\`\`\`\`text\n${first}\n\`\`\`\``);
    expect(decision.renderedText).toContain(`\`\`\`text\n${second}\`\`\``);
    expect(decision.renderedText).not.toContain(JSON.stringify([first, second]));
    expect(decision.resolutions.find(item => item.requirementId === "message.known_text")?.state).toBe("supported");
    expect(decision.resolutions.find(item => item.requirementId === "message.parts")?.state).toBe("unknown");
    expect(decision.resolutions.find(item => item.requirementId === "original_user_decision")?.state).toBe("unknown"); expect(decision.questionComplete).toBe(false);
  });
  it.each([null, { status: "accepted", detail: "原字段" }])("accepts a hash-bound whole field %j without granting raw completeness", async value => {
    const { session } = setup(`loopRuns ${id} 验证是什么？`); await read(session, construction(records([row("loopRuns", id, { status: "completed" })])));
    await read(session, construction({ fieldRead: field(value) }, "field-1")); const decision = await finish(session);
    expect(decision.resolutions.find(item => item.requirementId === "loopRuns.verificationResult")?.state).toBe(value === null ? "not_recorded" : "supported"); expect(decision.questionComplete).toBe(true);
  });
  it.each(["field_too_large", "version_changed", "not_published", "not_found_in_scope"])("keeps %s as an explicit unread gap", async status => {
    const { session } = setup(`loopRuns ${id} 验证是什么？`); await read(session, construction({ fieldRead: field(null, status) })); const decision = await finish(session);
    expect(decision.resolutions.find(item => item.requirementId === "loopRuns.verificationResult")?.reason).toBe(status); expect(decision.questionComplete).toBe(false);
  });
  it.each(["permission_denied", "query_error"])("keeps source %s distinct from a tool policy allow", async status => {
    const { session, auditSink } = setup(`loopRuns ${id} 验证是什么？`); await read(session, construction({ fieldRead: field(null, status) }));
    const registration = auditSink.mock.calls.map(([item]) => item).find(item => item.eventKey === "read-1:result_constructed")!;
    expect((registration.payload.receipt as any).authorization).toMatchObject({ toolPolicyDecision: "allowed", decision: status === "permission_denied" ? "denied" : "not_checked" });
  });
  it("prioritizes a matching denied field over a prior positive field", async () => {
    const { session } = setup(`loopRuns ${id} 验证是什么？`); await read(session, construction({ fieldRead: field("先前内容") }));
    await read(session, construction({ fieldRead: field(null, "permission_denied") }, "denied")); const decision = await finish(session);
    expect(decision.resolutions.find(item => item.requirementId === "loopRuns.verificationResult")?.state).toBe("denied"); expect(decision.renderedText).not.toContain("先前内容");
  });
  it("rejects a changed field value, text or private-only result", async () => {
    for (const mode of ["value_hash", "visible_hash"] as const) {
      const { session } = setup(`loopRuns ${id} 验证是什么？`), result = { fieldRead: field("原值") }, c = construction(result);
      if (mode === "value_hash") { result.fieldRead.fields[0].value = "篡改值"; c.modelText = JSON.stringify(result); } else c.modelText = JSON.stringify({ fieldRead: field("其它值") });
      await read(session, c); expect((await finish(session)).resolutions.find(item => item.requirementId === "loopRuns.verificationResult")?.state).toBe("unknown");
    }
  });
  it("accepts fixed textParts only as known text and rejects duplicate indices", async () => {
    for (const duplicate of [false, true]) {
      const { session } = setup(`message ${id} 内容是什么？`); await read(session, construction(records([row("message", id, { role: "user", chatId: linked })])));
      await read(session, construction({ fieldRead: field([{ index: 0, text: "第一段" }, { index: duplicate ? 0 : 3, text: "第二段" }], "read", "textParts", "message") }, "field-1"));
      expect((await finish(session)).resolutions.find(item => item.requirementId === "message.known_text")?.state).toBe(duplicate ? "unknown" : "supported");
    }
  });
  it.each(["denied", "failed", "aborted", "audit_failed"])("cannot commit claimed facts after %s", async variant => {
    const { session } = setup(undefined, { ...(variant === "denied" ? { authorizeFinal: async () => false } : {}), ...(variant === "audit_failed" ? { auditSink: async () => { throw Error("offline"); } } : {}) });
    await read(session, construction(records([row("loopRuns", id, { status: "completed", outputSummary: "秘密正文" })])));
    const decision = await finish(session, "unsafe", variant === "failed" || variant === "aborted" ? { ...terminal, status: variant } : terminal);
    expect(decision.questionComplete).toBe(false); expect(decision.evidenceRefs).toEqual([]); expect(decision.renderedText).not.toContain("秘密正文");
    if (variant === "denied") expect(decision.resolutions.every(item => item.state === "denied")).toBe(true);
  });
  it("leaves shadow body unchanged and does not grant displayed verification", async () => {
    const { session } = setup(undefined, { mode: "shadow" }); await read(session, construction(records([row("loopRuns", id, { status: "completed", outputSummary: "原值" })])));
    const decision = await finish(session, "原模型回答"); expect(decision.renderedText).toBe("原模型回答"); expect(decision.candidateDisplayText).toContain("原值"); expect(decision.resolutions.every(item => !item.presentationIncluded)).toBe(true);
    expect(decision.candidateDisplayText).toContain("存储的运行状态只描述运行记录，不证明业务验收通过或业务真实效果");
  });
  it("recognizes frozen exactRecords while naming snapshot scope explicitly", async () => {
    const { session } = setup(undefined, { snapshotAt: at, timePolicy: { mode: "unconstrained" } });
    const result = { data: { exactRecords: { observedAt: at, records: [row("loop_runs", id, { status: "completed", output_summary: "快照输出" })] } } };
    await read(session, construction(result)); const decision = await finish(session); expect(decision.questionComplete).toBe(true); expect(decision.renderedText).toContain(`采集于 ${at} 的只读快照`);
  });
  it.each(["matched", "different", "live"])("does not replace an explicitly requested capture with %s metadata", async mode => {
    const question = `在随题提供的只读数据快照（${at}）中，针对所选关联记录：chat ${id} 标题是什么？`;
    const { session } = setup(question, { ...(mode === "live" ? {} : { snapshotAt: mode === "matched" ? at : "2026-10-04T00:00:00.000Z" }), timePolicy: { mode: "unconstrained" } });
    await read(session, construction(records([row("chat", id, { title: "捕获标题" })]))); const decision = await finish(session);
    expect(decision.questionComplete).toBe(mode === "matched");
    if (mode !== "matched") { expect(decision.evidenceRefs).toEqual([]); expect(decision.renderedText).not.toContain("捕获标题"); expect(decision.resolutions.every(item => item.reason === "requested_snapshot_not_matched")).toBe(true); }
  });
  it.each([true, false])("validates first-page message identity independently of known-text completion %s", async textComplete => {
    const { session } = setup(`message ${id} 表达了什么？`);
    const parentHash = "a".repeat(64), structure = platformMessageStructure("message", { role: "assistant", chatId: linked, parts: [{ type: "text", text: textComplete ? "短原文" : "长".repeat(3000) }] }, { source: "message", id, offset: 0, expectedHash: parentHash });
    const page = { status: "read", source: "message", id, offset: 0, truncated: true, nextOffset: 100, content: "unparseable raw prefix", contentHash: parentHash, observedAt: at, messageStructure: structure };
    await read(session, construction({ recordRead: page })); const decision = await finish(session);
    expect(decision.resolutions.find(item => item.requirementId === "message.role")?.state).toBe("supported");
    expect(decision.resolutions.find(item => item.requirementId === "message.chatId")?.state).toBe("supported");
    expect(decision.resolutions.find(item => item.requirementId === "message.known_text")?.state).toBe(textComplete ? "supported" : "unknown");
    expect(decision.questionComplete).toBe(false);
    expect(decision.resolutions.find(item => item.requirementId === "message.interpretation")?.state).toBe("unknown");
  });
  it.each(["valid", "later_page", "hash_changed", "visible_changed", "duplicate_field", "value_changed"])("checks published whole short fields without parsing raw prefixes: %s", async variant => {
    const { session } = setup(`chat ${id} 标题是什么？`), contentHash = "a".repeat(64);
    const publishedFacts = platformPublishedRecordFacts({ source: "chat", id, parentContentHash: contentHash, fields: { id, title: "元数据标题" } })!;
    if (variant === "hash_changed") publishedFacts.parentContentHash = "b".repeat(64);
    if (variant === "duplicate_field") publishedFacts.fields.push(publishedFacts.fields[0]);
    if (variant === "value_changed") (publishedFacts.fields.find(item => item.fieldKey === "title") as any).value = "篡改标题";
    const page = { status: "read", source: "chat", id, offset: variant === "later_page" ? 100 : 0, truncated: true, nextOffset: 100, content: "{incomplete", contentHash, observedAt: at, publishedFacts };
    const c = construction({ recordRead: page });
    if (variant === "visible_changed") c.modelText = JSON.stringify({ recordRead: { ...page, content: "different" } });
    await read(session, c); const decision = await finish(session);
    expect(decision.questionComplete).toBe(variant === "valid");
    if (variant !== "valid") expect(decision.renderedText).not.toContain("元数据标题");
  });
  it("does not grant identity or text from a first-page structure changed only in model text", async () => {
    const { session } = setup(`message ${id} 表达了什么？`);
    const page = { status: "read", source: "message", id, offset: 0, truncated: true, messageStructure: platformMessageStructure("message", { role: "user", chatId: linked, parts: [{ type: "text", text: "原文" }] }, { source: "message", id, offset: 0, expectedHash: "a".repeat(64) }) };
    await read(session, construction({ recordRead: page }, "read-1", JSON.stringify({ recordRead: { ...page, messageStructure: { ...page.messageStructure, role: "assistant" } } })));
    expect((await finish(session)).evidenceCoverage.supported).toBe(0);
  });
  it.each(["platform-published-record-facts.v1", "platform-published-record-facts.v2"])("preserves legacy whole scalar identity for %s", async version => {
    const { session } = setup(`message ${id} 角色与所属聊天 ID`);
    await read(session, construction({ recordRead: publishedPage(version, "Message_v2", { role: "assistant", chatId: linked }) }));
    expect((await finish(session)).questionComplete).toBe(true);
  });
  it("reads a v2 whole trigger object and multiline summary without granting raw-record coverage", async () => {
    const { session } = setup(`loopRuns ${id} 的结果和触发原因是什么？`), triggerReason = { kind: "scheduled", details: { labels: ["a", null] } }, outputSummary = "原输出第一行\n第二行";
    await read(session, construction({ recordRead: publishedPage("platform-published-record-facts.v2", "loop_runs", { status: "completed", error: null, triggerReason, outputSummary }) }));
    const decision = await finish(session); expect(decision.questionComplete).toBe(true); expect(decision.ruleVersion).toBe("platform-compact-interpretation.v7");
    expect(decision.renderedText).toContain(outputSummary); expect(decision.renderedText).toContain(JSON.stringify(triggerReason, null, 2));
  });
  it.each(["legacy_new_key", "legacy_large_scalar", "legacy_object", "summary_object", "value_hash", "parent_source", "parent_id", "packet_budget", "unknown_version"])("does not widen published-field authority for %s", async variant => {
    const key = variant === "legacy_large_scalar" || variant === "legacy_object" ? "role" : "outputSummary", source = key === "role" ? "message" : "loopRuns";
    const { session } = setup(key === "role" ? `message ${id} 角色是什么？` : `loopRuns ${id} 的结果是什么？`);
    const value = variant === "legacy_large_scalar" ? "r".repeat(513) : variant === "legacy_object" || variant === "summary_object" ? { unsafe: "object" } : "整段输出";
    const version = variant.startsWith("legacy_") ? "platform-published-record-facts.v1" : variant === "unknown_version" ? "platform-published-record-facts.v999" : "platform-published-record-facts.v2";
    const page = publishedPage(version, source, { [key]: value });
    if (variant === "value_hash") page.publishedFacts.fields[0].valueHash = "b".repeat(64);
    if (variant === "parent_source") page.publishedFacts.source = "loops";
    if (variant === "parent_id") page.publishedFacts.id = linked;
    if (variant === "packet_budget") (page.publishedFacts as any).padding = "x".repeat(4000);
    await read(session, construction({ recordRead: page }));
    const decision = await finish(session); expect(decision.resolutions.find(item => item.requirementId === `${source}.${key}`)?.state).toBe("unknown"); expect(decision.questionComplete).toBe(false);
  });
  it("keeps a legacy three-thousand packet cap instead of applying the v2 cap", async () => {
    const { session } = setup(`chat ${id} 标题是什么？`), page = publishedPage("platform-published-record-facts.v1", "chat", { title: "旧版标题" });
    (page.publishedFacts as any).padding = "x".repeat(2800);
    expect(JSON.stringify(page.publishedFacts).length).toBeGreaterThan(3000); expect(JSON.stringify(page.publishedFacts).length).toBeLessThan(4000);
    await read(session, construction({ recordRead: page })); expect((await finish(session)).questionComplete).toBe(false);
  });
  it("never reconstructs whole facts from a truncated raw prefix when metadata is absent", async () => {
    const { session } = setup(`loopRuns ${id} 的结果是什么？`);
    await read(session, construction({ recordRead: { status: "read", source: "loopRuns", id, offset: 0, truncated: true, nextOffset: 100,
      content: JSON.stringify({ source: "loopRuns", id, fields: { status: "completed", outputSummary: "raw-prefix诱饵" } }), contentHash: "a".repeat(64), observedAt: at } }));
    const decision = await finish(session); expect(decision.questionComplete).toBe(false); expect(decision.renderedText).not.toContain("raw-prefix诱饵");
  });
});
describe("complete owner metrics", () => {
  it("keeps proved storage count and separate unknown effective count", async () => {
    const { session } = setup("记忆数量和状态分布是多少，有多少实际有效？"); await read(session, construction({ data: { statistics: { results: [metric()] } } })); const decision = await finish(session);
    expect(decision.outcome).toBe("partial"); expect(decision.renderedText).toContain("总数 3"); expect(decision.renderedText).toContain("null=1"); expect(decision.questionComplete).toBe(false);
  });
  it.each(["missing_proof", "foreign_owner", "changed_count", "wrong_time"])("rejects %s rather than extrapolating a sample", async variant => {
    const { session } = setup("当前记忆总数和状态分布"), member = metric(variant === "foreign_owner" ? "other" : "owner");
    if (variant === "missing_proof") { member.scopeProof = undefined; (member as any).semantics = { fullOwnerGroupQuery: true }; }
    if (variant === "changed_count") member.groups[0].count = 3;
    if (variant === "wrong_time") member.observedAt = "2026-10-04T02:00:00.000Z";
    await read(session, construction({ data: { statistics: { results: [member] } } })); const decision = await finish(session); expect(decision.outcome).toBe("unknown"); expect(decision.renderedText).not.toContain("总数 3");
  });
  it("preserves proved owner totals while keeping an unobserved exact event unknown", async () => {
    const { session } = setup(`记忆状态总数是多少，interactionEvents ${id} 原文是什么，是否存在？`);
    await read(session, construction({ data: { statistics: { results: [metric()] } } })); const decision = await finish(session);
    expect(decision.outcome).toBe("partial"); expect(decision.renderedText).toContain("总数 3"); expect(decision.questionComplete).toBe(false);
    expect(decision.resolutions.find(item => item.requirementId === "specific_raw_event")).toMatchObject({ state: "unknown", reason: "specific_raw_event_receipt_required", evidenceIds: [] });
    expect(decision.renderedText).toContain("不能确认该事件存在");
  });
  it.each([
    { question: "模拟委托状态各有多少笔，区分委托和实际成交？", source: "paper_orders.status", boundary: "paper_order_fill_ledger", reason: "paper_fill_ledger_required", detail: "实际成交数量" },
    { question: "当前用户的消息理解作业，等待、完成、失败等状态各有多少个？失败作业不等于消息消失。", source: "interaction_processing_jobs.status", boundary: "processing_failure_not_disappearance", reason: "raw_event_lifecycle_receipt_required", detail: "不能确认每条原始消息的存续" },
  ])("shows stored counts and a precise independent boundary for $source", async ({ question, source, boundary, reason, detail }) => {
    const { session } = setup(question), { total, groups } = metric();
    const member = { source, total, groups, status: "ok", observedAt: at, scopeProof: createLivePlatformStatisticsProof({ ownerId: "owner", source, total, groups, observedAt: at }) };
    await read(session, construction({ data: { statistics: { results: [member] } } })); const decision = await finish(session);
    expect(decision.renderedText).toContain("总数 3"); expect(decision.renderedText).toContain(detail); expect(decision.questionComplete).toBe(false);
    expect(decision.resolutions.find(item => item.requirementId === boundary)).toMatchObject({ state: "unknown", reason, evidenceIds: [] });
  });
});
describe("shared platform stream gate", () => {
  it("suppresses provisional conclusions and emits one committed bound answer", async () => {
    const { session } = setup(), c = construction(records([row("loopRuns", id, { status: "completed", outputSummary: "真实输出" })])); await session.observeToolConstruction(c);
    async function* source(): AsyncGenerator<AgentMessage> { yield { type: "text", content: "危险前缀" }; yield event(c); yield { type: "result", content: "success" }; yield { type: "runtime_terminal", runtimeTerminal: terminal }; yield { type: "done" }; }
    const events: AgentMessage[] = []; for await (const item of guardPlatformAnswer(source(), session)) events.push(item);
    expect(events.filter(item => item.type === "text")).toHaveLength(1); expect(events.find(item => item.type === "text")?.content).not.toContain("危险前缀");
    expect(events.find(item => item.type === "answer_evidence")?.answerEvidence).toMatchObject({ schemaVersion: "platform-answer-summary.v1", kind: "platform", questionComplete: true });
  });
});
describe("opt-in SDK context readonly continuation", () => {
  function planned(overrides: { enabled?: boolean; budget?: Partial<MemoryReadBudgetSnapshot>; question?: string; bindingMismatch?: boolean } = {}) {
    const identity = { ownerId: "owner", turnId: "turn", requester: { kind: "chat" as const, id: "chat-1" } };
    const registry = new PlatformReadHandleRegistry(identity, { now: () => Date.parse(at) });
    const budget = { ...createMemoryReadBudget().snapshot(), ...overrides.budget };
    const { session, auditSink } = setup(overrides.question ?? `loopRuns ${id} 的状态、结果和验证是什么？`, { ...(overrides.enabled === false ? {} : { readonlyContinuation: {
      enabled: true as const, resolveReadHandle: (handle: string) => { const binding = registry.resolve(handle, identity); return overrides.bindingMismatch ? { ...binding, contentHash: "b".repeat(64) } : binding; },
      readBudgetSnapshot: () => budget,
    } }) });
    const result = attachPlatformReadHandlesToResult(records([row("loopRuns", id, { status: "completed" }, { representation: "bounded_projection", contentHash: "a".repeat(64),
      fieldAvailability: { status: "shown", outputSummary: "present_unread", verificationResult: "present_unread" } })]), registry);
    const c = construction(result);
    return { session, auditSink, c, registry };
  }
  it("starts off by default and cannot use constructed or model-only handles", async () => {
    for (const mode of ["off", "constructed", "model_only"] as const) {
      const { session, c } = planned({ enabled: mode !== "off" });
      if (mode !== "model_only") await session.observeToolConstruction(c);
      if (mode === "off" || mode === "model_only") await session.observeContextCommitted({ toolCallId: c.toolCallId, entryId: "entry", modelText: c.modelText! });
      expect(await session.beforeClose()).toBeNull();
    }
  });
  it("uses only SDK-committed host handles, once, without waiting for SSE emission", async () => {
    const { session, c, auditSink } = planned(); await session.observeToolConstruction(c);
    await session.observeContextCommitted({ toolCallId: c.toolCallId, entryId: "entry", modelText: c.modelText! });
    expect(session.snapshot()).toMatchObject({ receiptCount: 0, contextReceiptCount: 1 });
    const candidate = await session.beforeClose(); expect(candidate?.readHandles).toHaveLength(1); expect(candidate?.followUp).toContain("原问题及所有问项保持不变"); expect(candidate?.followUp).toContain("下一次额外响应必须仅结束回答");
    expect(await session.beforeClose()).toBeNull(); expect(auditSink.mock.calls.map(([item]) => item.eventType)).not.toContain("readonly_continuation_started");
    await session.observeContinuationStarted({ readHandles: candidate!.readHandles, maxForwards: 2, maxReads: 2, reservedOutputTokens: 256 });
    await session.observeContinuationStarted({ readHandles: candidate!.readHandles, maxForwards: 2, maxReads: 2, reservedOutputTokens: 256 });
    expect(auditSink.mock.calls.filter(([item]) => item.eventType === "readonly_continuation_started")).toHaveLength(1);
    expect((await finish(session)).questionComplete).toBe(false);
  });
  it("rejects mismatched SDK admission and propagates failed start audit", async () => {
    const { session, c, auditSink } = planned(); await session.observeToolConstruction(c);
    await session.observeContextCommitted({ toolCallId: c.toolCallId, entryId: "entry", modelText: c.modelText! });
    const candidate = (await session.beforeClose())!;
    await expect(session.observeContinuationStarted({ readHandles: [], maxForwards: 2, maxReads: 2, reservedOutputTokens: 128 })).rejects.toThrow("admitted episode");
    auditSink.mockImplementation(async () => { throw Error("audit unavailable"); });
    const input = { readHandles: candidate.readHandles, maxForwards: 2 as const, maxReads: 2 as const, reservedOutputTokens: 128 };
    await expect(session.observeContinuationStarted(input)).rejects.toThrow("audit was not committed");
    await expect(session.observeContinuationStarted(input)).rejects.toThrow("audit was not committed");
  });
  it.each(["closed_registry", "wrong_binding", "attempts", "characters", "in_flight"])("closes with an auditable gap for %s", async variant => {
    const { session, c, registry, auditSink } = planned({ bindingMismatch: variant === "wrong_binding", budget: variant === "attempts" ? { attempts: 10 }
      : variant === "characters" ? { committedCharacters: 63_000 } : variant === "in_flight" ? { inFlight: 1, inFlightSize: "unknown_until_formatted" } : {} });
    await session.observeToolConstruction(c); await session.observeContextCommitted({ toolCallId: c.toolCallId, entryId: "entry", modelText: c.modelText! });
    if (variant === "closed_registry") registry.close();
    expect(await session.beforeClose()).toBeNull(); expect(auditSink.mock.calls.some(([item]) => item.eventKey.startsWith("read_phase_closed:"))).toBe(true);
  });
  it("grants one remaining original attempt and preserves the other original obligation", async () => {
    const { session, c } = planned({ budget: { attempts: 9 } }); await session.observeToolConstruction(c);
    await session.observeContextCommitted({ toolCallId: c.toolCallId, entryId: "entry", modelText: c.modelText! });
    expect((await session.beforeClose())?.readHandles).toHaveLength(1); expect(session.plan?.requirements.map(item => item.id)).toContain("loopRuns.verificationResult");
  });
  it.each([23_999, 24_000, 48_000])("reserves the entire host maximum formatted envelope with %i characters remaining", async remaining => {
    const { session, c } = planned({ budget: { committedCharacters: 64_000 - remaining } }); await session.observeToolConstruction(c);
    await session.observeContextCommitted({ toolCallId: c.toolCallId, entryId: "entry", modelText: c.modelText! });
    const candidate = await session.beforeClose(); expect(candidate?.readHandles.length ?? 0).toBe(remaining < 24_000 ? 0 : 1);
  });
  it("does not admit a continuation if the host budget is unavailable", async () => {
    const { session, c } = planned({ budget: { maximumSingleCharacters: undefined } }); await session.observeToolConstruction(c);
    await session.observeContextCommitted({ toolCallId: c.toolCallId, entryId: "entry", modelText: c.modelText! }); expect(await session.beforeClose()).toBeNull();
  });
  it("does not supplement live fields for an unmatched explicitly requested snapshot", async () => {
    const { session, c } = planned({ question: `在随题提供的只读数据快照（${at}）中，针对所选关联记录：loopRuns ${id} 的状态、结果和验证是什么？` });
    await session.observeToolConstruction(c); await session.observeContextCommitted({ toolCallId: c.toolCallId, entryId: "entry", modelText: c.modelText! }); expect(await session.beforeClose()).toBeNull();
  });
  it("does not repeat a field_too_large receipt or supplement a business definition", async () => {
    const { session, c } = planned({ question: `loopRuns ${id} 的验证是否说明已成功生效？` }); await session.observeToolConstruction(c);
    await session.observeContextCommitted({ toolCallId: c.toolCallId, entryId: "entry", modelText: c.modelText! });
    const gap = construction({ fieldRead: field(null, "field_too_large") }, "gap"); await session.observeToolConstruction(gap);
    await session.observeContextCommitted({ toolCallId: gap.toolCallId, entryId: "gap-entry", modelText: gap.modelText! });
    // Output remains a needed field in this wording, so only that one may be read.
    const next = await session.beforeClose(); expect(next?.readHandles).toHaveLength(1);
    expect(session.plan?.requirements.some(item => item.id === "business_or_later_outcome")).toBe(true);
  });
});
