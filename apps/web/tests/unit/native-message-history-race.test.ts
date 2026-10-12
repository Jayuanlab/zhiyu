import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@openzhiyu/shared";
import {
  findNativeAssistantIndex,
  mergeChatHistory,
  nativeAssistantSnapshot,
} from "@/lib/ai/chat/native-message-state";
import { mergeBackgroundChatMessages } from "@/components/chat/background-messages";

const source = readFileSync(new URL("../../components/chat-context.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("chat-context.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function nodes(predicate: (node: ts.Node) => boolean) {
  const result: ts.Node[] = [];
  function visit(node: ts.Node) {
    if (predicate(node)) result.push(node);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return result;
}
function callback(name: string) {
  return (nodes((node) => ts.isPropertyAssignment(node) && node.name.getText(ast) === name)[0] as ts.PropertyAssignment).initializer.getText(ast);
}
function compile(code: string) {
  return ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
}
const maxMessages = Number((nodes((node) => ts.isVariableDeclaration(node) && node.name.getText(ast) === "MAX_MESSAGES_PER_CHAT")[0] as ts.VariableDeclaration).initializer!.getText(ast));
function applyHistory(baseline: ChatMessage[], current: ChatMessage[], history: ChatMessage[]) {
  const setter = (nodes((node) => ts.isCallExpression(node) && node.expression.getText(ast) === "setMessagesMap" && node.getStart(ast) > source.indexOf("const switchChatId ="))[0] as ts.CallExpression).arguments[0];
  const apply = vm.runInNewContext(compile("(" + setter.getText(ast) + ")"), { newChatId: "chat", uiMessages: history, existingMessages: baseline, historyBaseline: baseline, mergeChatHistory, mergeBackgroundChatMessages, protectedMessageIds: [], pendingAssistantIdsRef: { current: new Map() }, MAX_MESSAGES_PER_CHAT: maxMessages });
  return apply(new Map([["chat", current]])).get("chat") as ChatMessage[];
}
const currentId = "00000000-0000-4000-8000-000000000001";
const oldId = "00000000-0000-4000-8000-000000000002";
const message = (id: string, text = ""): ChatMessage => ({ id, role: "assistant", parts: [{ type: "text", text }] } as ChatMessage);
function stream(messages: ChatMessage[]) {
  const saves: ChatMessage[][] = [];
  const state = {
    parts: [] as any[], textContent: "", assistantMessageId: currentId,
    assistantMessageIdForRetry: currentId, chatIdForMessages: "chat", newMessageStartIndex: 0,
    messagesMapRef: { current: new Map([["chat", messages]]) }, receivedMessageIds: new Set(),
    findNativeAssistantIndex, nativeAssistantSnapshot,
    setMessages: (updater: (prev: ChatMessage[]) => ChatMessage[]) => {
      messages = updater(messages);
      state.messagesMapRef.current.set("chat", messages);
    },
    setIsAgentRunningFn() {}, saveAssistantMessage() {},
    saveMessagesToDatabase: (items: ChatMessage[]) => { saves.push(items); return Promise.resolve({ success: true }); },
    setIsSending() {}, chatIdForAbort: null, activeChatId: null, abortFnRef: { current: null },
    setStreamRetryCount() {}, setIsRetrying() {}, mutate() {}, toast() {},
    pendingAssistantIdsRef: { current: new Map() },
  };
  const context = vm.createContext(state);
  return {
    state, saves,
    update: vm.runInContext(compile("(" + callback("onUpdate") + ")"), context),
    done: vm.runInContext(compile("(" + callback("onDone") + ")"), context),
    messages: () => messages,
  };
}

describe("native stream identity at actual callback boundaries", () => {
  it("updates the current assistant even when history follows it", async () => {
    const old = message(oldId, "historic");
    const s = stream([message(currentId), old]);
    await s.update({ type: "text", content: "current delta" });
    expect(s.messages()[0].parts).toEqual([{ type: "text", text: "current delta" }]);
    expect(s.messages()[1]).toBe(old);
  });
  it("saves only the local final snapshot despite late historical messages", async () => {
    const s = stream([message(currentId), ...Array.from({ length: 10 }, (_, n) => message("old-" + n))]);
    s.state.parts = [{ type: "text", text: "final delta" }];
    s.state.textContent = "final delta";
    await s.done();
    expect(s.saves).toEqual([[{ id: currentId, role: "assistant", content: "final delta", parts: [{ type: "text", text: "final delta" }] }]]);
  });
  it("does not depend on a React ref effect committing the final update", async () => {
    const s = stream([message(currentId, "stale")]);
    s.state.messagesMapRef.current = new Map();
    s.state.parts = [{ type: "text", text: "uncommitted final" }];
    s.state.textContent = "uncommitted final";
    await s.done();
    expect(s.saves[0][0].parts).toEqual([{ type: "text", text: "uncommitted final" }]);
  });
  it("preserves final tool, reasoning and audit reference parts", async () => {
    const s = stream([message(currentId)]);
    const parts = [{ type: "reasoning", text: "synthetic" }, { type: "tool-native", status: "completed" }, { type: "data-answerEvidence", data: { turnId: oldId } }];
    s.state.parts = parts;
    await s.done();
    expect(s.saves[0][0].parts).toEqual(parts);
    expect(s.saves[0][0].parts).not.toBe(parts);
  });
  it("does not target a user or another assistant if current identity is absent", async () => {
    const old = message(oldId, "historic");
    const s = stream([{ ...message(currentId), role: "user" } as ChatMessage, old]);
    await s.update({ type: "text", content: "current delta" });
    expect(s.messages()[1]).toBe(old);
    expect(s.messages()[0].parts).toEqual([{ type: "text", text: "" }]);
  });
  it("keeps tool use, result and reasoning updates on the current assistant", async () => {
    const old = message(oldId, "historic"), s = stream([message(currentId), old]);
    await s.update({ type: "tool_use", toolUseId: "synthetic", name: "platformRecall", input: { readOnly: true } });
    await s.update({ type: "tool_result", toolUseId: "synthetic", content: "synthetic result", isError: false });
    await s.update({ type: "reasoning", text: "synthetic reasoning" });
    expect(s.messages()[1]).toBe(old);
    expect(s.messages()[0].parts).toEqual(expect.arrayContaining([expect.objectContaining({ type: "tool-native", status: "completed" }), { type: "reasoning", text: "synthetic reasoning" }]));
  });
});

describe("history fetch three-way reconciliation", () => {
  it("keeps a current turn added after history fetch started", () => {
    const local = message(currentId, "streaming");
    expect(mergeChatHistory([], [local], [message(oldId, "server")])).toEqual([message(oldId, "server"), local]);
  });
  it("retains updates made during the fetch, with server-only history", () => {
    const before = message(currentId, "before"), local = message(currentId, "after");
    expect(mergeChatHistory([before], [local], [message(oldId, "server"), message(currentId, "stale server")])).toEqual([message(oldId, "server"), local]);
  });
  it("refreshes unchanged local history instead of always preferring it", () => {
    const before = message(oldId, "before"), server = message(oldId, "updated server");
    expect(mergeChatHistory([before], [before], [server])).toEqual([server]);
  });
  it("accepts server deletion of unchanged history", () => {
    const before = message(oldId);
    expect(mergeChatHistory([before], [before], [])).toEqual([]);
  });
  it("does not resurrect a local deletion made during the fetch", () => {
    const before = message(oldId);
    expect(mergeChatHistory([before], [], [message(oldId, "server")])).toEqual([]);
  });
  it("does not duplicate a current ID also returned in server history", () => {
    const local = message(currentId, "new local");
    const merged = mergeChatHistory([], [local], [message(currentId, "server")]);
    expect(merged).toEqual([local]);
  });
  it("uses the actual functional history setter to preserve a newly started turn", () => {
    const local = message(currentId, "streaming"), history = [message(oldId, "server")];
    expect(applyHistory([], [local], history)).toEqual([...history, local]);
  });
  it("refreshes unchanged history through the actual force-refresh response setter", () => {
    const before = message(oldId, "before"), server = message(oldId, "new server");
    expect(applyHistory([before], [before], [server])).toEqual([server]);
  });
  it("preserves the original message limit when reconciling late history", () => {
    const local = message(currentId, "streaming");
    const history = Array.from({ length: maxMessages + 5 }, (_, n) => message("history-" + n));
    const merged = applyHistory([], [local], history);
    expect(merged).toHaveLength(maxMessages);
    expect(merged.at(-1)).toBe(local);
    expect(merged[0].id).toBe("history-6");
  });
});
