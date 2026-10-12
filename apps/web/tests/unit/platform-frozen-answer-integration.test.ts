import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createPiAgentRuntime } from "@openzhiyu/ai/agent/runtime";
// @ts-expect-error TS5097: Vitest/tsx resolves this script's explicit ESM extension; the app compiler does not emit it.
import { createFrozenEvalTools } from "../../scripts/lib/platform-eval-v2-frozen-tools.mts";
import { createPlatformAnswerSession } from "@/lib/ai/runtime/platform-answer-session";
import { guardPlatformAnswer } from "@/lib/ai/runtime/platform-answer-gate";
import { createMemoryReadBudget } from "@/lib/ai/memory-read-budget";
import { PlatformReadHandleRegistry, type PlatformReadIdentity } from "@/lib/ai/platform-read-handle-registry";
import { createProviderOutputBudget } from "@openzhiyu/ai/agent/runtime/provider-output-budget";

vi.mock("@/lib/db/client", () => ({ db: {}, withDatabaseTransaction: () => { throw Error("Production DB must not be used by frozen tests"); } }));
const folders: string[] = [];
const ownerId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";
const loopId = "33333333-3333-4333-8333-333333333333";
const messageId = "44444444-4444-4444-8444-444444444444";
const chatId = "55555555-5555-4555-8555-555555555555";
const capturedAt = "2026-10-04T03:00:00.000Z";
afterEach(() => { for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true }); });
function fixture(question: string) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "zhiyu-platform-frozen-answer-")); folders.push(folder);
  const manifest = { ownerId, recordSnapshotCapturedAt: capturedAt, repositoryCapturedAt: capturedAt, sourceHashes: {} };
  const rows = [
    { kind: "database_row", id: "run", table: "loop_runs", recordId: runId,
      content: { id: runId, loop_id: loopId, status: "completed", output_summary: "实际已生成可读取的分析结果", verification_result: { status: "verified", unreadDetail: "x".repeat(18000) } } },
    { kind: "database_row", id: "loop", table: "loops", recordId: loopId,
      content: { id: loopId, name: "研究任务", goal: "分析事实", status: "active" } },
    { kind: "database_row", id: "message", table: "Message_v2", recordId: messageId,
      content: { id: messageId, chat_id: chatId, role: "assistant", parts: [{ type: "text", text: "原始已知正文" }, { type: "tool-call", payload: "x".repeat(24000) }] } },
    { kind: "database_row", id: "chat", table: "Chat", recordId: chatId, content: { id: chatId, title: "事实问答历史" } },
    { kind: "database_aggregate", id: "aggregate:jobs", table: "interaction_processing_jobs",
      query: 'SELECT s."status" AS value, count(*)::int AS count FROM "interaction_processing_jobs" s WHERE s.user_id = $1 GROUP BY s."status" ORDER BY s."status" NULLS FIRST',
      parameters: [ownerId], content: { groupedBy: "status", total: 7, groups: [{ value: "completed", count: 5 }, { value: "running", count: 2 }] } },
  ].map(row => ({ ...row, ownerId, capturedAt, sha256: createHash("sha256").update(JSON.stringify(row.content)).digest("hex") }));
  fs.writeFileSync(path.join(folder, "manifest.json"), JSON.stringify(manifest), "utf8");
  fs.writeFileSync(path.join(folder, "corpus.jsonl"), rows.map(row => JSON.stringify(row)).join("\n"), "utf8");
  return { folder, manifest, question: { id: "fixture", question, requester: { userId: ownerId } } };
}
const findHandles = (value: any): any[] => {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(findHandles);
  return [...(Array.isArray(value.readHandles) ? value.readHandles : []), ...Object.values(value).flatMap(findHandles)];
};

describe("frozen tools through the same answer core and real local SDK", () => {
  it("uses complete published message identity and known text from an incomplete raw page, then binds the independently read chat title", async () => {
    const data = fixture(`Message_v2 ${messageId} 表达了什么，出自哪个聊天、哪个角色？是否包含用户已作出的决定？`);
    const session = createPlatformAnswerSession({ mode: "enforce_supported", turnId: "turn", ownerId,
      question: data.question.question, policyHash: "policy", runtimeHash: "runtime", snapshotAt: capturedAt,
      timePolicy: { mode: "unconstrained" }, auditSink: async () => undefined, authorizeFinal: async () => true });
    const tools = createFrozenEvalTools({ ...data, turnId: "turn", onResultConstructed: receipt => session.observeToolConstruction(receipt) });
    const faux = createFauxCore({});
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("platformRecall", { recordRead: { source: "message", id: messageId } }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("platformRecall", { recordRead: { source: "chat", id: chatId } }), { stopReason: "toolUse" }),
      fauxAssistantMessage("原始消息已全部读完，也代表用户决定"),
    ]);
    const runtime = createPiAgentRuntime({ adapter: "harness", model: faux.getModel(), streamFn: faux.streamSimple, tools });
    const events = [];
    for await (const event of guardPlatformAnswer(runtime.run({ operation: "run", prompt: data.question.question,
      options: { onToolContextCommitted: receipt => session.observeContextCommitted(receipt) } }), session)) events.push(event);
    const parent = JSON.parse(events.find(event => event.type === "tool_result")?.output ?? "{}");
    expect(parent.recordRead.nextOffset).not.toBeNull();
    const answer = events.find(event => event.type === "result")?.content ?? "";
    expect(answer).toContain("assistant"); expect(answer).toContain(chatId);
    expect(answer).toContain("原始已知正文"); expect(answer).toContain("事实问答历史");
    expect(answer).not.toContain("原始消息已全部读完，也代表用户决定");
    expect(session.snapshot().decision?.questionComplete).toBe(false);
  });
  it.each(["bounded", "off", "unknown_output_budget"] as const)("handles early stopping with %s admission and the original read/output ledgers", async admission => {
    const data = fixture(`loopRuns ${runId} 的输出和验证结果是什么？`);
    const identity: PlatformReadIdentity = { ownerId, requester: { kind: "chat", id: "fixture" }, turnId: "turn" };
    const registry = new PlatformReadHandleRegistry(identity);
    const readBudget = createMemoryReadBudget();
    const outputBudget = createProviderOutputBudget({ perRequestTokens: 2200, totalReservedTokens: 21 * 2200 });
    const audits: any[] = [];
    const session = createPlatformAnswerSession({ mode: "enforce_supported", turnId: "turn", ownerId,
      question: data.question.question, policyHash: "policy", runtimeHash: "runtime", snapshotAt: capturedAt,
      timePolicy: { mode: "unconstrained" }, auditSink: async event => { audits.push(event); }, authorizeFinal: async () => true,
      ...(admission !== "off" ? { readonlyContinuation: { enabled: true as const,
        resolveReadHandle: handle => registry.resolve(handle, identity), readBudgetSnapshot: readBudget.snapshot } } : {}),
    });
    const tools = createFrozenEvalTools({ ...data, turnId: "turn", platformReadRegistry: registry, platformReadIdentity: identity,
      memoryReadBudget: readBudget, onResultConstructed: receipt => session.observeToolConstruction(receipt) });
    const faux = createFauxCore({});
    let invocation = 0, episodeActive = false;
    let admittedHandles: string[] = [];
    const forwardCaps: number[] = [];
    const streamFn = async (model: any, context: any, options: any) => {
      invocation++;
      const cap = episodeActive ? model.maxTokens : Math.min(model.maxTokens, outputBudget.reserveMainForward());
      forwardCaps.push(cap);
      if (invocation === 1) faux.setResponses([fauxAssistantMessage(fauxToolCall("platformRecall", { question: data.question.question }), { stopReason: "toolUse" })]);
      else if (invocation === 2) faux.setResponses([fauxAssistantMessage("提前结束：已经全部读完并验收成功")]);
      else if (invocation === 3) {
        // The already known oversized verifier is a retained gap, not a safe continuation candidate.
        expect(admittedHandles).toHaveLength(1);
        faux.setResponses([fauxAssistantMessage(admittedHandles.map(readHandle => fauxToolCall("platformRecall", { readHandle })), { stopReason: "toolUse" })]);
      } else faux.setResponses([fauxAssistantMessage("补读结束，但仍需验证未读字段")]);
      return faux.streamSimple({ ...model, maxTokens: cap }, context, { ...options, maxTokens: cap });
    };
    const runtime = createPiAgentRuntime({ adapter: "harness", model: { ...faux.getModel(), maxTokens: 2200 }, streamFn, tools });
    const events = [];
    for await (const event of guardPlatformAnswer(runtime.run({ operation: "run", prompt: data.question.question, options: {
      onToolContextCommitted: receipt => session.observeContextCommitted(receipt),
      ...(admission !== "off" ? { hostReadonlyContinuation: {
        beforeClose: session.beforeClose,
        reserveOutputTokens: admission === "bounded" ? outputBudget.reserveContinuationEpisode : () => null,
        onEpisodeStarted: async episode => { await session.observeContinuationStarted(episode); admittedHandles = episode.readHandles; episodeActive = true; },
      } } : {}),
    } }), session)) events.push(event);
    const answer = events.find(event => event.type === "result")?.content ?? "";
    expect(answer).not.toContain("已经全部读完并验收成功");
    expect(session.snapshot().decision, JSON.stringify(events.filter(event => event.type === "error" || event.type === "runtime_terminal"))).toMatchObject({ outcome: "partial", questionComplete: false, auditPersisted: true, auditIncomplete: false });
    expect(events.find(event => event.type === "runtime_terminal")?.runtimeTerminal?.status).toBe("completed");
    expect(invocation).toBe(admission === "bounded" ? 4 : 2);
    expect(readBudget.snapshot().attempts).toBe(admission === "bounded" ? 2 : 1);
    expect(outputBudget.snapshot().reservedTokens).toBe(admission === "bounded" ? 8800 : 4400);
    expect(forwardCaps.every(cap => cap === 2200)).toBe(true);
    expect(audits.filter(event => event.eventType === "readonly_continuation_started")).toHaveLength(admission === "bounded" ? 1 : 0);
    if (admission === "bounded") expect(answer).toContain("实际已生成可读取的分析结果");
    registry.close();
  });
  it("delivers a directed complete output field from a bounded raw record and retains the unread verification gap", async () => {
    const data = fixture(`loopRuns ${runId} 的输出和验证结果是什么？`);
    const audits: any[] = [];
    const session = createPlatformAnswerSession({ mode: "enforce_supported", turnId: "turn", ownerId,
      question: data.question.question, policyHash: "policy", runtimeHash: "runtime", snapshotAt: capturedAt,
      timePolicy: { mode: "unconstrained" }, auditSink: async event => { audits.push(event); }, authorizeFinal: async () => true });
    const budget = createMemoryReadBudget();
    const tools = createFrozenEvalTools({ ...data, turnId: "turn", memoryReadBudget: budget, onResultConstructed: receipt => session.observeToolConstruction(receipt) });
    const faux = createFauxCore({}); let invocation = 0;
    const streamFn = async (model: any, context: any, options: any) => {
      invocation++;
      if (invocation === 1) faux.setResponses([fauxAssistantMessage(fauxToolCall("platformRecall", { question: data.question.question }), { stopReason: "toolUse" })]);
      else if (invocation === 2) {
        const toolResult = context.messages.findLast((message: any) => message.role === "toolResult");
        const body = JSON.parse(toolResult.content.find((block: any) => block.type === "text").text);
        const handle = findHandles(body).find(item => item.source === "loopRuns" && item.id === runId && item.fieldKey === "outputSummary");
        expect(handle).toBeTruthy();
        faux.setResponses([fauxAssistantMessage(fauxToolCall("platformRecall", { readHandle: handle.readHandle }), { stopReason: "toolUse" })]);
      } else faux.setResponses([fauxAssistantMessage("草稿：所有工作都成功验收了")]);
      return faux.streamSimple(model, context, options);
    };
    const runtime = createPiAgentRuntime({ adapter: "harness", model: faux.getModel(), streamFn, tools });
    const output = [];
    for await (const event of guardPlatformAnswer(runtime.run({ operation: "run", prompt: data.question.question,
      options: { onToolContextCommitted: receipt => session.observeContextCommitted(receipt) } }), session)) output.push(event);
    const answer = output.find(event => event.type === "result")?.content;
    expect(answer).toContain("实际已生成可读取的分析结果");
    expect(answer).not.toContain("所有工作都成功验收了");
    expect(answer).toContain("未取得对应字段");
    expect(session.snapshot().decision).toMatchObject({ outcome: "partial", questionComplete: false, auditPersisted: true, auditIncomplete: false });
    expect(audits.some(event => event.eventType === "context_committed")).toBe(true);
    expect(budget.snapshot().attempts).toBe(2);
  });
  it("accepts the manifest-pinned fixed full query and renders stored counts without inventing active worker activity", async () => {
    const data = fixture("当前处理任务的状态分布有多少，执行器是否正在处理？");
    const session = createPlatformAnswerSession({ mode: "enforce_supported", turnId: "turn", ownerId,
      question: data.question.question, policyHash: "policy", runtimeHash: "runtime", snapshotAt: capturedAt,
      timePolicy: { mode: "unconstrained" }, auditSink: async () => undefined, authorizeFinal: async () => true });
    const tools = createFrozenEvalTools({ ...data, turnId: "turn", onResultConstructed: receipt => session.observeToolConstruction(receipt) });
    const faux = createFauxCore({});
    faux.setResponses([fauxAssistantMessage(fauxToolCall("platformRecall", { question: data.question.question }), { stopReason: "toolUse" }), fauxAssistantMessage("运行中两条所以处理器在运行")]);
    const runtime = createPiAgentRuntime({ adapter: "harness", model: faux.getModel(), streamFn: faux.streamSimple, tools });
    const output = [];
    for await (const event of guardPlatformAnswer(runtime.run({ operation: "run", prompt: data.question.question,
      options: { onToolContextCommitted: receipt => session.observeContextCommitted(receipt) } }), session)) output.push(event);
    expect(output.find(event => event.type === "result")?.content).toContain("总数 7");
    expect(output.find(event => event.type === "result")?.content).toContain('"completed" `=5');
    expect(output.find(event => event.type === "result")?.content).toContain("需要匹配运行及租约");
    expect(session.snapshot().decision?.auditPersisted).toBe(true);
  });
});
