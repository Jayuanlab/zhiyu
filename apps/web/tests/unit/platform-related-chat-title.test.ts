import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
// @ts-expect-error TS5097: Vitest/tsx resolves this script's explicit ESM extension; the app compiler does not emit it.
import { createFrozenEvalTools } from "../../scripts/lib/platform-eval-v2-frozen-tools.mts";
import { createNativePiWebChatToolDefinitions } from "@/lib/ai/native-pi-web-chat-tools";
import { recallPlatformInformationForUser } from "@/lib/ai/platform-recall";
import { readPlatformRecordForOwner } from "@/lib/ai/platform-record-reader";
import { createMemoryReadBudget } from "@/lib/ai/memory-read-budget";
import { PlatformReadHandleRegistry } from "@/lib/ai/platform-read-handle-registry";
import { createGuardedPiTool, type GuardedPiToolReceipt } from "@/lib/ai/runtime/pi-tool-adapter";
import { createPlatformAnswerSession } from "@/lib/ai/runtime/platform-answer-session";

const owner = "11111111-1111-4111-8111-111111111111", messageId = "22222222-2222-4222-8222-222222222222", chatId = "33333333-3333-4333-8333-333333333333";
const at = "2026-10-02T06:01:46.768Z", repoAt = "2026-10-02T06:18:28.762Z";
const hash = (value: unknown) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const question = `在随题提供的只读数据快照（${at}）中，消息记录 ${messageId} 的角色、正文和所属聊天标题是什么？`;
const fields = { id: messageId, chatId, role: "assistant", parts: [{ type: "text", text: "原查询，不是批准指令" }, { type: "tool-result", output: "x".repeat(20000) }], createdAt: at };
const chatFields = { id: chatId, title: "New Chat", visibility: "public", createdAt: at };
function frozenFixture(options: { chat?: boolean; duplicateChat?: boolean; conflictingAlias?: boolean; chatTitle?: string; knownTexts?: string[] } = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "zhiyu-related-chat-title-unit-"));
  const manifest = { ownerId: owner, recordSnapshotCapturedAt: at, repositoryCapturedAt: repoAt, sourceHashes: {} };
  const messageFields = { id: messageId, chat_id: chatId, role: fields.role,
    parts: options.knownTexts ? [...options.knownTexts.map(text => ({ type: "text", text })), { type: "tool-result", output: "x".repeat(20000) }] : fields.parts, created_at: at,
    ...(options.conflictingAlias ? { chatId: messageId } : {}) };
  const row = (table: string, id: string, content: unknown, suffix = "") => ({ kind: "database_row", id: `db:${table}:${id}${suffix}`, table, recordId: id,
    ownerId: owner, content, sha256: hash(content), capturedAt: at });
  const documents = [row("Message_v2", messageId, messageFields), ...(options.chat === false ? [] : [row("Chat", chatId, { ...chatFields, ...(options.chatTitle !== undefined ? { title: options.chatTitle } : {}) })]),
    ...(options.duplicateChat ? [row("Chat", chatId, { ...chatFields, title: "ambiguous title" }, ":duplicate")] : [])];
  fs.writeFileSync(path.join(folder, "manifest.json"), JSON.stringify(manifest), { encoding: "utf8", flag: "wx" });
  fs.writeFileSync(path.join(folder, "corpus.jsonl"), documents.map(document => JSON.stringify(document)).join("\n"), { encoding: "utf8", flag: "wx" });
  return { folder, manifest, messageFields };
}

describe("native and captured related-title delivery", () => {
  it("native definition forwards only the host original question, turn identity and the same budget", async () => {
    const identity = { ownerId: owner, requester: { kind: "chat" as const, id: "desktop" }, turnId: "turn" };
    const registry = new PlatformReadHandleRegistry(identity), budget = createMemoryReadBudget();
    const query = vi.fn(async (source: readonly string[], ids: string[], userId: string) => {
      expect(userId).toBe(owner); return source[0] === "message" && ids[0] === messageId ? [fields] : source[0] === "chat" && ids[0] === chatId ? [chatFields] : [];
    });
    const unused = () => { throw Error("Unexpected broad adapter"); };
    const adapters: NonNullable<Parameters<typeof recallPlatformInformationForUser>[1]> = { readRecord: input => readPlatformRecordForOwner(input, query),
      inspectWork: unused, listLoops: unused, listArchitectureMemories: unused, listSnapshots: unused, listGrants: unused,
      listKnowledgeDocuments: unused, listToolCapabilities: unused };
    const recall = vi.fn(async (input: Parameters<typeof recallPlatformInformationForUser>[0]) => recallPlatformInformationForUser(input, adapters));
    const args: Parameters<typeof createNativePiWebChatToolDefinitions> = [];
    args[0] = { userId: owner, question: `消息记录 ${messageId} 的角色、正文和所属聊天标题是什么？`, turnId: "turn",
      platformReadRegistry: registry, platformReadIdentity: identity, memoryReadBudget: budget };
    args[22] = recall;
    const definition = createNativePiWebChatToolDefinitions(...args).find(tool => tool.name === "platformRecall")!;
    const receipts: GuardedPiToolReceipt[] = [];
    const tool = createGuardedPiTool({ ...budget.wrap([definition])[0], onResultConstructed: receipt => { receipts.push(receipt); } });
    const result = await tool.execute("native-read", { question: "role only", recordRead: { source: "message", id: messageId } });
    const text = result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
    const visible = JSON.parse(text);
    expect(visible.fieldRead).toMatchObject({ source: "chat", id: chatId, fields: [{ fieldKey: "title", value: "New Chat" }] });
    expect(visible.recordRead.contentHash).toBe(hash(JSON.stringify({ source: "message", id: messageId, fields })));
    expect(visible.recordRead.nextOffset).not.toBeNull();
    expect(query.mock.calls.map(call => call[0][0])).toEqual(["message", "chat", "message"]);
    expect(budget.snapshot()).toMatchObject({ attempts: 3, inFlight: 0, maximumAttempts: 10, maximumSingleCharacters: 24000, maximumTotalCharacters: 64000 });
    expect(text.length).toBeLessThan(24000); expect(receipts).toHaveLength(1); expect(receipts[0].modelText).toBe(text);
    expect(recall.mock.calls[0][0].memoryReadBudget).toBe(budget);
    expect(recall.mock.calls[0][0].originalQuestion).toBe(args[0].question);
  });
  it.each(["message", "Message_v2"])("preserves the actual %s first-page bytes/hash and delivers a separate whole chat field", async source => {
    const fixture = frozenFixture(), budget = createMemoryReadBudget(), receipts: GuardedPiToolReceipt[] = [];
    const tools = createFrozenEvalTools({ ...fixture, question: { id: "private-fixture", question, requester: { userId: owner } }, memoryReadBudget: budget,
      onResultConstructed: receipt => { receipts.push(receipt); } });
    const result = await tools.find(tool => tool.name === "platformRecall")!.execute(`read-${source}`, { recordRead: { source, id: messageId } });
    const visible = JSON.parse(result.content.filter(block => block.type === "text").map(block => block.text).join("\n"));
    const raw = JSON.stringify({ source, id: messageId, fields: source === "message" ? fields : fixture.messageFields });
    expect(visible.recordRead).toMatchObject({ status: "read", source, id: messageId, content: raw.slice(0, 8000), contentHash: hash(raw), nextOffset: 8000 });
    expect(visible.fieldRead).toMatchObject({ status: "read", source: "chat", id: chatId, parentContentHash: hash(JSON.stringify({ source: "chat", id: chatId, fields: chatFields })),
      observation: { kind: "frozen_capture", observedAt: at }, fields: [{ fieldKey: "title", value: "New Chat", valueHash: hash(JSON.stringify("New Chat")), complete: true }] });
    expect(visible.fieldRead.parentContentHash).not.toBe(visible.recordRead.contentHash);
    expect(receipts).toHaveLength(1); expect(receipts[0].result).toHaveProperty("fieldRead"); expect(receipts[0].modelText).toContain('"fieldRead"');
    expect(budget.snapshot().attempts).toBe(3);
  });
  it.each(["wrong_hash", "continuation", "different_subject", "no_title_obligation"])("skips all associated queries for %s", async vector => {
    const fixture = frozenFixture(), budget = createMemoryReadBudget();
    const requestedQuestion = vector === "different_subject" ? question.replace(messageId, chatId)
      : vector === "no_title_obligation" ? `消息记录 ${messageId} 的角色是什么？` : question;
    const tools = createFrozenEvalTools({ ...fixture, question: { id: "skip-fixture", question: requestedQuestion, requester: { userId: owner } }, memoryReadBudget: budget });
    const rawHash = hash(JSON.stringify({ source: "Message_v2", id: messageId, fields: fixture.messageFields }));
    const result = await tools.find(tool => tool.name === "platformRecall")!.execute("skip", { recordRead: { source: "Message_v2", id: messageId,
      ...(vector === "wrong_hash" ? { expectedHash: "a".repeat(64) } : vector === "continuation" ? { offset: 8000, expectedHash: rawHash } : {}) } });
    const visible = JSON.parse(result.content.filter(block => block.type === "text").map(block => block.text).join("\n"));
    expect(visible.fieldRead).toBeUndefined(); expect(visible.recordRead.relatedChatTitle).toBeUndefined(); expect(budget.snapshot().attempts).toBe(1);
  });
  it.each(["missing", "duplicate"])("delivers the message with an explicit %s child gap rather than a false title", async vector => {
    const fixture = frozenFixture({ chat: vector !== "missing", duplicateChat: vector === "duplicate" }), budget = createMemoryReadBudget();
    const tools = createFrozenEvalTools({ ...fixture, question: { id: "gap-fixture", question, requester: { userId: owner } }, memoryReadBudget: budget });
    const result = await tools.find(tool => tool.name === "platformRecall")!.execute("gap", { recordRead: { source: "Message_v2", id: messageId } });
    const visible = JSON.parse(result.content.filter(block => block.type === "text").map(block => block.text).join("\n"));
    expect(visible.recordRead.status).toBe("read"); expect(visible.fieldRead.fields).toEqual([]); expect(visible.fieldRead.coverage.fieldComplete).toBe(false);
    expect(visible.recordRead.relatedChatTitle.reads).toEqual([expect.objectContaining({ stage: "chat_title", queryAttempted: true, attemptCharged: true })]);
    expect(budget.snapshot().attempts).toBe(2);
  });
  it.each(["message", "Message_v2"])("rejects conflicting captured relation aliases before the %s associated read", async source => {
    const fixture = frozenFixture({ conflictingAlias: true }), budget = createMemoryReadBudget();
    const tools = createFrozenEvalTools({ ...fixture, question: { id: "alias-fixture", question, requester: { userId: owner } }, memoryReadBudget: budget });
    const result = await tools.find(tool => tool.name === "platformRecall")!.execute("alias", { recordRead: { source, id: messageId } });
    const visible = JSON.parse(result.content.filter(block => block.type === "text").map(block => block.text).join("\n"));
    expect(visible.recordRead.relatedChatTitle).toMatchObject({ status: "invalid_relation", reads: [] });
    expect(visible.fieldRead).toBeUndefined(); expect(budget.snapshot().attempts).toBe(1);
  });
  it.each(["subject_denied", "version_callback_only"])("exposes %s as a zero-child-query gap in the actual frozen tools", async vector => {
    const fixture = frozenFixture(), budget = createMemoryReadBudget(), authorize = vi.fn(async () => false);
    const authorizeSubject = vi.fn(async () => false);
    const tools = createFrozenEvalTools({ ...fixture, question: { id: "subject-deny-fixture", question, requester: { userId: owner } }, memoryReadBudget: budget,
      platformReadAuthorize: authorize, ...(vector === "subject_denied" ? { platformReadRelatedAuthorize: authorizeSubject } : {}) });
    const result = await tools.find(tool => tool.name === "platformRecall")!.execute("denied", { recordRead: { source: "Message_v2", id: messageId } });
    const visible = JSON.parse(result.content.filter(block => block.type === "text").map(block => block.text).join("\n"));
    expect(visible.recordRead.status).toBe("read"); expect(visible.fieldRead).toMatchObject({ status: "permission_denied", fields: [] });
    expect(visible.recordRead.relatedChatTitle.reads).toEqual([expect.objectContaining({ queryAttempted: false, attemptCharged: true, status: "permission_denied" })]);
    expect(authorize).not.toHaveBeenCalled(); expect(authorizeSubject).toHaveBeenCalledTimes(vector === "subject_denied" ? 1 : 0); expect(budget.snapshot().attempts).toBe(2);
  });
  it("withholds the complete outer packet and constructs no trusted receipt when its actual formatted text exceeds 24000", async () => {
    const fixture = frozenFixture({ chatTitle: "t".repeat(6800), knownTexts: Array.from({ length: 5 }, () => "a".repeat(1000)) });
    const budget = createMemoryReadBudget(), onResultConstructed = vi.fn();
    const tools = createFrozenEvalTools({ ...fixture, question: { id: "outer-cap-fixture", question, requester: { userId: owner } }, memoryReadBudget: budget, onResultConstructed });
    await expect(tools.find(tool => tool.name === "platformRecall")!.execute("outer-cap", { recordRead: { source: "Message_v2", id: messageId } })).rejects.toThrow("memory_read_output_over_budget");
    expect(onResultConstructed).not.toHaveBeenCalled(); expect(budget.snapshot()).toMatchObject({ attempts: 3, withheldResults: 1, inFlight: 0, maximumSingleCharacters: 24000 });
  });
  it.each(["construction_only", "context_only", "emitted", "final_denied"])("does not promote %s into a delivered/authorized title", async stage => {
    const fixture = frozenFixture(), identity = { ownerId: owner, requester: { kind: "chat" as const, id: "receipt-fixture" }, turnId: "turn" };
    const session = createPlatformAnswerSession({ mode: "enforce_supported", turnId: "turn", ownerId: owner, runtimeHash: "runtime", policyHash: "policy", question,
      snapshotAt: at, authorizeFinal: async plan => {
        if (stage === "emitted" || stage === "final_denied") expect(plan.finalAuthorizationSubjects).toEqual(expect.arrayContaining([{ source: "message", id: messageId }, { source: "chat", id: chatId }]));
        else expect(plan.finalAuthorizationSubjects ?? []).not.toContainEqual({ source: "chat", id: chatId });
        return stage !== "final_denied";
      }, auditSink: async () => undefined });
    const tools = createFrozenEvalTools({ ...fixture, platformReadIdentity: identity, question: { id: "receipt-fixture", question, requester: { userId: owner } },
      onResultConstructed: receipt => session.observeToolConstruction(receipt) });
    const result = await tools.find(tool => tool.name === "platformRecall")!.execute("read", { recordRead: { source: "Message_v2", id: messageId } });
    const text = result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
    if (stage !== "construction_only") await session.observeContextCommitted({ toolCallId: "read", entryId: "sdk-entry", modelText: text });
    if (stage === "emitted" || stage === "final_denied") await session.observeToolResult({ type: "tool_result", toolUseId: "read", output: text, isError: false, toolResultDetails: result.details });
    const decision = await session.finalize({ terminal: { schemaVersion: "agent-runtime-terminal.v1", status: "completed", cleanupStatus: "completed" }, rawDraft: "Untrusted draft" });
    const resolution = decision.resolutions.find(item => item.requirementId === "chat.title");
    expect(resolution?.state).toBe(stage === "emitted" ? "supported" : stage === "final_denied" ? "denied" : "unknown");
    if (stage !== "emitted") expect(decision.renderedText).not.toContain("New Chat");
    else expect(decision.renderedText).toContain("New Chat");
  });
});
