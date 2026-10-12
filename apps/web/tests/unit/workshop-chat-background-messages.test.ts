import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@openzhiyu/shared";
import { mergeBackgroundChatMessages, sameMessageReferences } from "@/components/chat/background-messages";
import { isWorkshopChatTool, workshopToolText } from "@/components/message/workshop-tool-text";
import { findNativeAssistantIndex, nativeAssistantSnapshot } from "@/lib/ai/chat/native-message-state";

const chatId = "11111111-1111-4111-8111-111111111111";
const workId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
function message(id: string, text: string, createdAt?: string): ChatMessage {
  return { id, role: "assistant", parts: [{ type: "text", text }], metadata: createdAt ? { createdAt } : undefined } as ChatMessage;
}
const source = readFileSync(new URL("../../components/chat-context.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("chat-context.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function callback(name: string) {
  let found: ts.Expression | undefined;
  function visit(node: ts.Node) {
    if (!found && ts.isPropertyAssignment(node) && node.name.getText(ast) === name) found = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(ast);
  expect(found).toBeDefined();
  return ts.transpileModule("(" + found!.getText(ast) + ")", {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
}

describe("owner chat background delivery reconciliation", () => {
  it("adds an asynchronous result exactly once without replacing a live reply", () => {
    const live = message("stream", "unfinished"), delivered = message("delivery", "research complete");
    const snapshot = { chatId, baseline: [live], messages: [message("stream", "stale"), delivered] };
    const first = mergeBackgroundChatMessages(snapshot, [live], new Set(["stream"]));
    expect(first).toEqual([live, delivered]);
    expect(first[0]).toBe(live);
    const second = mergeBackgroundChatMessages({ ...snapshot, baseline: first }, first, new Set(["stream"]));
    expect(second).toHaveLength(2);
    expect(sameMessageReferences(first, second)).toBe(true);
  });
  it("protects a stream captured before its save acknowledgment even after release", () => {
    const final = message("stream", "final");
    const merged = mergeBackgroundChatMessages({ chatId, baseline: [final],
      protectedMessageIds: ["stream"], messages: [message("stream", "old database body")] }, [final], new Set());
    expect(merged).toEqual([final]);
    expect(merged[0]).toBe(final);
  });
  it("preserves edits made while the history read was pending", () => {
    const before = message("stream", "before"), current = message("stream", "after");
    expect(mergeBackgroundChatMessages({ chatId, baseline: [before], messages: [message("stream", "server stale")] }, [current], new Set())[0]).toBe(current);
  });
  it("does not treat absence from a bounded history window as deletion", () => {
    const old = message("old", "older retained body");
    expect(mergeBackgroundChatMessages({ chatId, baseline: [old], messages: [message("new", "new result")] }, [old], new Set())).toEqual([message("new", "new result"), old]);
  });
  it("does not resurrect a local deletion that occurred during fetch", () => {
    const old = message("old", "before deletion");
    expect(mergeBackgroundChatMessages({ chatId, baseline: [old], messages: [old] }, [], new Set())).toEqual([]);
  });
  it("refreshes unchanged persisted text and filters another chat's payload", () => {
    const old = message("old", "before"), server = message("old", "after");
    const foreign = { ...message("foreign", "private"), chatId: "other-chat" } as ChatMessage;
    expect(mergeBackgroundChatMessages({ chatId, baseline: [old], messages: [server, foreign] }, [old], new Set())).toEqual([server]);
  });
  it("loads a result into an empty reopened chat and retains its metadata", () => {
    const delivered = { ...message("delivery", "finished"), metadata: { workshopChatDelivery: { version: 1, deliveryId: "receipt", workshopId: workId, runId, sourceMessageId: "owner-command", status: "completed" } } } as ChatMessage;
    expect(mergeBackgroundChatMessages({ chatId, baseline: [], messages: [delivered, delivered] }, [], new Set())).toEqual([delivered]);
  });
  it("orders persisted deliveries after an earlier ongoing assistant reply", () => {
    const live = message("live", "in progress", "2026-10-09T01:00:00Z");
    const delivered = message("delivery", "finished", "2026-10-09T01:01:00Z");
    expect(mergeBackgroundChatMessages({ chatId, baseline: [live], messages: [delivered] }, [live], new Set(["live"]))).toEqual([live, delivered]);
  });
});

describe("actual chat callback boundaries", () => {
  it("routes a late delivery to its original chat while another conversation is active", () => {
    const other = message("other", "another conversation");
    const live = message("live", "current streaming body");
    let state = new Map([[chatId, [live]], ["other-chat", [other]]]);
    const onSuccess = vm.runInNewContext(callback("onSuccess"), {
      setMessagesMap: (update: (previous: typeof state) => typeof state) => { state = update(state); },
      mergeBackgroundChatMessages, sameMessageReferences, MAX_MESSAGES_PER_CHAT: 1000,
      pendingAssistantIdsRef: { current: new Map([[chatId, new Set(["live"])]]) },
    });
    const delivered = message("delivery", "completed research");
    onSuccess({ chatId, baseline: [live], messages: [message("live", "server stale"), delivered] });
    expect(state.get(chatId)).toEqual([live, delivered]);
    expect(state.get("other-chat")).toEqual([other]);
    onSuccess({ chatId, baseline: state.get(chatId), messages: [message("live", "server stale"), delivered] });
    expect(state.get(chatId)).toHaveLength(2);
  });
  it("preserves the original command and does not synthesize a new user message after disconnect", async () => {
    const original = { ...message("owner", "run the learner"), role: "user" } as ChatMessage;
    let messages = [original, message("stream", "accepted")];
    const sendMessage = vi.fn(), schedule = vi.fn(), saveMessagesToDatabase = vi.fn().mockResolvedValue({ success: true });
    const onError = vm.runInNewContext(callback("onError"), {
      Error, setIsSending() {}, chatIdForAbort: chatId, activeChatId: "other-chat",
      abortFnRef: { current: null }, setChatSessionStates() {}, getChatSessionState() { return {}; },
      findNativeAssistantIndex, assistantMessageId: "stream", chatIdForMessages: chatId,
      setMessages(update: (previous: ChatMessage[]) => ChatMessage[]) { messages = update(messages); },
      parts: [{ type: "text", text: "accepted" }], textContent: "accepted", nativeAssistantSnapshot,
      saveMessagesToDatabase, pendingAssistantIdsRef: { current: new Map([[chatId, new Set(["stream"])]]) },
      toast() {}, formatAgentStreamErrorForUser(_scope: string, detail: string) { return detail; },
      sendMessage, setTimeout: schedule,
    });
    await onError(new Error("network timeout"));
    expect(messages[0]).toBe(original);
    expect(messages).toHaveLength(2);
    expect(messages[1].parts).toEqual(expect.arrayContaining([expect.objectContaining({ type: "error", content: expect.stringContaining("不会自动重复交办") })]));
    expect(sendMessage).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
    expect(saveMessagesToDatabase).toHaveBeenCalledWith([expect.objectContaining({ id: "stream" })], chatId, { immediate: true });
  });
});

describe("ordinary Workshop tool feedback", () => {
  it("distinguishes a replayed pause receipt from the Work's current state", () => {
    const feedback = workshopToolText("setWorkshopAvailability", "completed", {
      ok: true, replayed: true, workshopId: workId, result: { status: "future_paused" },
    });
    expect(feedback?.text).toContain("原操作回执");
    expect(feedback?.text).not.toContain("后续运行已暂停");
    expect(feedback?.href).toBe(`/workshop?workId=${workId}`);
  });
  it("reports queued as queued and constructs an exact local link from IDs", () => {
    const feedback = workshopToolText("runWorkshopOnce", "completed", { status: "success", result: {
      ok: true, status: "run_accepted", workshopId: workId,
      workshop: { id: workId }, run: { id: runId, workshopId: workId, status: "queued" }, workshopUrl: "https://attacker.example/",
    } });
    expect(feedback).toEqual({ text: "本轮已排队，等待执行。", href: `/workshop?workId=${workId}&runId=${runId}`, linkText: "查看本轮记录" });
    expect(feedback?.text).not.toContain("完成");
  });
  it("retains unknown readback without encouraging another run", () => {
    expect(workshopToolText("runWorkshopOnce", "error", { ok: false, status: "run_readback_pending", workshopId: workId, runId })?.text).toContain("同一轮");
  });
  it("never displays mismatched targets or forged creation IDs as verified", () => {
    expect(workshopToolText("runWorkshopOnce", "completed", { ok: true, status: "run_accepted", workshopId: workId,
      run: { id: runId, workshopId: chatId, status: "completed" } })).toBeNull();
    expect(workshopToolText("applyWorkshopManifestYaml", "completed", { ok: true, status: "created_verified", workshop: { id: "javascript:alert(1)" } })).toBeNull();
  });
  it("does not turn a manifest review into a creation receipt", () => {
    expect(workshopToolText("reviewWorkshopManifestYaml", "completed", { review: { ok: true } })).toEqual({ text: "配置检查通过，尚未创建智能体。" });
    expect(workshopToolText("applyWorkshopManifestYaml", "completed", { review: { ok: true } })).toBeNull();
  });
  it("has no action feedback before the tool returns and covers unified control tools", () => {
    expect(workshopToolText("runWorkshopOnce", "executing", { ok: true })).toBeNull();
    expect(isWorkshopChatTool("assignWorkshopTask")).toBe(true);
    expect(isWorkshopChatTool("amendWorkshopRun")).toBe(true);
    expect(isWorkshopChatTool("unrelatedTool")).toBe(false);
  });
  it("shows an individual operation failure without declaring effects undone", () => {
    const feedback = workshopToolText("setWorkshopLoopStatus", "completed", {
      interfaceVersion: "workshop-agent-operation.v1", operationId: "setWorkshopLoopStatus", ok: false,
      receipt: { ids: { workId, runId: null }, readbackStatus: "verified" },
      error: { code: "VERSION_CONFLICT", message: "排期已改变，暂停尚未确认。" },
    });
    expect(feedback).toEqual({ text: "本次车间操作返回异常：排期已改变，暂停尚未确认。", href: `/workshop?workId=${workId}`, linkText: "查看工作记录" });
    expect(feedback?.text).not.toContain("回滚");
  });
});
