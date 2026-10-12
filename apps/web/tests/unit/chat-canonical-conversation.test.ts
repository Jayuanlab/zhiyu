import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { findNativeAssistantIndex, nativeAssistantSnapshot } from "@/lib/ai/chat/native-message-state";
import { mergeBackgroundChatMessages } from "@/components/chat/background-messages";
import { buildNavigationUrl } from "@openzhiyu/shared";

const paths = {
  header: "../../components/agent/chat-header-panel.tsx",
  panel: "../../components/agent/chat-panel.tsx",
  home: "../../app/(chat)/home.tsx",
  context: "../../components/chat-context.tsx",
  input: "../../components/multimodal-input.tsx",
};
type Surface = keyof typeof paths;
const sources = Object.fromEntries(Object.entries(paths).map(([key, path]) => [
  key, ts.createSourceFile(path, readFileSync(new URL(path, import.meta.url), "utf8"),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX),
])) as Record<Surface, ts.SourceFile>;

function find(surface: Surface, predicate: (node: ts.Node) => boolean) {
  let found: ts.Node | undefined;
  function visit(node: ts.Node) {
    if (!found && predicate(node)) found = node;
    ts.forEachChild(node, visit);
  }
  visit(sources[surface]);
  if (!found) throw new Error(`Missing actual ${surface} callback seam`);
  return found;
}
function callback(surface: Surface, name: string) {
  const declaration = find(surface, node => ts.isVariableDeclaration(node) &&
    node.name.getText(sources[surface]) === name) as ts.VariableDeclaration;
  const initializer = declaration.initializer!;
  return ts.isCallExpression(initializer) && initializer.expression.getText(sources[surface]) === "useCallback"
    ? initializer.arguments[0] : initializer;
}
function evaluate<T>(surface: Surface, expression: ts.Node, scope: Record<string, unknown>): T {
  const js = ts.transpileModule(`(${expression.getText(sources[surface]).replace(/^export /, "")})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
  }).outputText;
  return vm.runInNewContext(js, scope) as T;
}

const oldChatId = "11111111-1111-4111-8111-111111111111";
const newChatId = "22222222-2222-4222-8222-222222222222";
const localChatId = "33333333-3333-4333-8333-333333333333";

function contextHarness(capturedChatId = oldChatId) {
  let activeChatId = capturedChatId;
  let isSending = false;
  let saveAllowed = true;
  let nextMessage = 0;
  let sessionStates = new Map<string, any>();
  const historic = { id: "historic", role: "assistant", parts: [{ type: "text", text: "old output" }] };
  let messages = new Map<string, any[]>([[oldChatId, [historic]]]);
  const saves: Array<{ chatId: string; items: any[] }> = [];
  const streams: any[] = [];
  const persisted = new Map<string, any[]>();
  const cancel = vi.fn();
  const common = {
    messagesMapRef: { get current() { return messages; } },
    pendingAssistantIdsRef: { current: new Map<string, Set<string>>() },
    setMessages: (update: (before: any[]) => any[], chatId: string) => messages.set(chatId, update(messages.get(chatId) ?? [])),
    setMessagesMap: (update: (before: typeof messages) => typeof messages) => { messages = update(messages); },
    setActiveChatId: (value: string) => { activeChatId = value; },
    setIsSending: (value: boolean) => { isSending = value; },
    setChatSessionStates: (update: (before: typeof sessionStates) => typeof sessionStates) => { sessionStates = update(sessionStates); },
    getChatSessionState: (chatId: string) => sessionStates.get(chatId) ?? {},
    saveMessagesToDatabase: async (items: any[], chatId: string) => {
      saves.push({ chatId, items });
      if (!saveAllowed) return null;
      const byId = new Map((persisted.get(chatId) ?? []).map(item => [item.id, item]));
      for (const item of items) byId.set(item.id, item);
      persisted.set(chatId, [...byId.values()]);
      return { success: true, chat: { id: chatId } };
    },
    generateUUID: () => `synthetic-message-${++nextMessage}`,
    setTimeout: (resolve: () => void) => { resolve(); return 0; },
    mutate() {}, toast() {}, console,
  };
  const send = evaluate<(message: unknown, options?: unknown) => Promise<void>>("context", callback("context", "sendMessage"), {
    ...common, activeChatId: capturedChatId, messages: messages.get(capturedChatId) ?? [],
    buildNativeConversation: (items: any[]) => items,
    isTauri: () => false, getModelConfig: () => undefined, selectedModel: "default", DEFAULT_AI_MODEL: "synthetic",
    setIsAgentRunningFn() {}, loopIdForGuard: null, abortFnRef: { current: null },
    streamNativeAgentResponse: async (_text: string, options: any) => { streams.push(options); options.onAbortFnReady(cancel); return cancel; },
    t: (key: string) => key, findNativeAssistantIndex, nativeAssistantSnapshot,
  });
  const switchTo = (target: string, locked = isSending) => evaluate<(id: string) => Promise<void>>("context", callback("context", "switchChatId"), {
    ...common, isSending: locked, setIsInsightDrawerOpen() {}, setSelectedInsight() {},
    MAX_MESSAGES_PER_CHAT: 1000, mergeBackgroundChatMessages,
    fetch: async () => ({ status: 404 }),
  })(target);
  return { send, saves, streams, persisted, cancel, historic, switchTo,
    get activeChatId() { return activeChatId; }, get isSending() { return isSending; },
    get messages() { return messages; }, setSending(value: boolean) { isSending = value; },
    rejectSave() { saveAllowed = false; },
  };
}

function panelSend(sendMessage: (...args: any[]) => any, switching = false) {
  return evaluate<(message: unknown, options?: unknown) => Promise<void>>("panel", callback("panel", "sendMessagePresent"), {
    sendMessage, chatId: newChatId, isChatSwitching: switching,
    isAgentRunning: false, isAgentRunningForChat: false, console, Error, Promise,
  });
}

function renderPanel(activeChatId: string, messages: any[] = [], sendMessage = vi.fn().mockResolvedValue(undefined)) {
  const effects: Array<() => unknown> = [];
  const context = {
    activeChatId, messages, sendMessage, setMessages: vi.fn(), stop: vi.fn(),
    isVaultOpen: false, setVaultOpen() {}, focusedInsights: [], getIsAgentRunningByChatId: () => false,
  };
  const scope: Record<string, unknown> = {
    React: { createElement }, useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? "translated" }),
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/",
    useSearchParams: () => new URLSearchParams({ page: "chat", chatId: newChatId }),
    useState: (initial: unknown) => [typeof initial === "function" ? (initial as () => unknown)() : initial, vi.fn()],
    useRef: (initial: unknown) => ({ current: initial }), useMemo: (value: () => unknown) => value(),
    useCallback: (value: unknown) => value, useEffect: (effect: () => unknown) => effects.push(effect),
    useChatContext: () => context, useGlobalInsightDrawer: () => ({ openDrawer() {} }), useSWR: () => ({ data: [] }), voteFetcher() {},
    cn: (...values: unknown[]) => values.filter(Boolean).join(" "), generateUUID: () => localChatId,
    Set, Map, Promise, Error, URLSearchParams, console,
  };
  for (const component of ["ErrorBoundary", "Button", "WorkspaceFloatPanel", "FocusedInsightFloatingBar",
    "VirtualizedMessages", "MultimodalInput", "ArrowUpIcon", "ArrowDownIcon"]) scope[component] = component;
  const component = find("panel", node => ts.isFunctionDeclaration(node) && node.name?.text === "AgentChatPanel");
  const render = evaluate<(props: { chatId: string }) => any>("panel", component, scope);
  const tree = render({ chatId: newChatId });
  const nodes: any[] = [];
  function visit(node: any) {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== "object") return;
    nodes.push(node);
    visit(node.props?.children);
  }
  visit(tree);
  return { nodes, effects, context };
}

describe("canonical conversation at actual component callbacks", () => {
  it("creates a conversation through the parent URL without clearing the old chat", () => {
    let urlChatId = oldChatId;
    const oldMessages = [{ id: "old", role: "assistant", parts: [{ type: "text", text: "retained old output" }] }];
    const clearMessages = vi.fn(), clearInsights = vi.fn(), switchChat = vi.fn();
    const parentNavigate = evaluate<(id: string | null) => void>("home", callback("home", "handleChatIdChange"), {
      page: "chat", pathname: "/", searchParams: new URLSearchParams({ page: "chat", chatId: oldChatId }),
      generateUUID: () => newChatId, buildNavigationUrl, console,
      router: { push: (url: string) => { urlChatId = new URL(url, "http://localhost").searchParams.get("chatId")!; } },
    });
    const navigate = vi.fn(parentNavigate);
    const handleNewChat = evaluate<() => void>("header", callback("header", "handleNewChat"), {
      chatContextOptional: { setMessages: clearMessages, clearFocusedInsights: clearInsights, switchChatId: switchChat },
      onChatIdChange: navigate, setTimeout: () => 0, scrollToRight() {},
      router: { push: vi.fn() },
    });

    handleNewChat();

    expect(urlChatId).toBe(newChatId);
    expect(navigate).toHaveBeenCalledExactlyOnceWith(null);
    expect(clearMessages).not.toHaveBeenCalled();
    expect(clearInsights).not.toHaveBeenCalled();
    expect(switchChat).not.toHaveBeenCalled();
    expect(oldMessages[0].parts[0].text).toBe("retained old output");
  });

  it("creates a canonical URL when a header has no parent navigation callback", () => {
    const push = vi.fn(), clear = vi.fn(), switchChatId = vi.fn();
    const handleNewChat = evaluate<() => void>("header", callback("header", "handleNewChat"), {
      chatContextOptional: { setMessages: clear, switchChatId }, onChatIdChange: undefined,
      searchParams: new URLSearchParams({ page: "chat", chatId: oldChatId }),
      generateUUID: () => newChatId, buildNavigationUrl, router: { push }, setTimeout: () => 0, scrollToRight() {},
    });
    handleNewChat();
    const url = new URL(push.mock.calls[0][0], "http://localhost");
    expect(url.pathname).toBe("/");
    expect(url.searchParams.get("page")).toBe("chat");
    expect(url.searchParams.get("chatId")).toBe(newChatId);
    expect(clear).not.toHaveBeenCalled();
    expect(switchChatId).not.toHaveBeenCalled();
  });

  it("binds manual persistence, stream context, and delayed delivery to the visible chat ID", async () => {
    // A stale context callback must not override the panel's canonical ID.
    const state = contextHarness();
    const send = panelSend(state.send);
    await send({ role: "user", parts: [{ type: "text", text: "synthetic owner command" }] });
    expect(state.saves[0].chatId).toBe(newChatId);
    expect(state.streams[0].chatId).toBe(newChatId);
    expect(state.streams[0].taskId).toBe(newChatId);
    expect(state.streams[0].conversation).toEqual([]);
    expect(state.messages.get(oldChatId)).toEqual([state.historic]);
    await state.streams[0].onDone();
    expect(state.saves.every(item => item.chatId === newChatId)).toBe(true);
    const delivery = { id: "delivery", role: "assistant" as const, parts: [{ type: "text" as const, text: "finished research" }],
      chatId: newChatId, metadata: { createdAt: "2026-10-09T01:00:00Z",
        workshopChatDelivery: { sourceMessageId: state.saves[0].items[0].id } } };
    const before = state.messages.get(newChatId) ?? [];
    const reconciled = mergeBackgroundChatMessages({ chatId: newChatId, baseline: before, messages: [delivery] }, before, new Set());
    expect(reconciled).toContain(delivery);
    expect(state.messages.get(oldChatId)).toEqual([state.historic]);
  });

  it("renders an explicit switching state and disables controls without exposing old messages", async () => {
    const old = { id: "old", role: "assistant", parts: [{ type: "text", text: "ongoing old output" }] };
    const view = renderPanel(oldChatId, [old]);
    const controls = view.nodes.find(node => node.type === "fieldset");
    expect(controls?.props.disabled).toBe(true);
    expect(view.nodes.find(node => node.props?.role === "status")?.props.children).toBe("正在切换对话，请稍候。当前运行会继续保存在原对话中。");
    expect(view.nodes.filter(node => node.type === "VirtualizedMessages")).toHaveLength(0);
    const input = view.nodes.find(node => node.type === "MultimodalInput");
    await expect(input.props.sendMessage("synthetic next command")).rejects.toThrow("正在切换对话");
    expect(view.context.sendMessage).not.toHaveBeenCalled();
    expect(view.context.stop).not.toHaveBeenCalled();
    expect(view.context.setMessages).not.toHaveBeenCalled();
    expect(old.parts[0].text).toBe("ongoing old output");
  });

  it("retains the original stream while switching is fenced, then enables the new chat after completion", async () => {
    const state = contextHarness();
    await state.send({ role: "user", parts: [{ type: "text", text: "synthetic first command" }] }, { chatId: oldChatId });
    expect(state.isSending).toBe(true);
    const homeEffect = (find("home", node => ts.isCallExpression(node) && node.expression.getText(sources.home) === "useEffect"
      && node.arguments[0].getText(sources.home).includes("switchChatId(effectiveChatId)")) as ts.CallExpression).arguments[0];
    const sync = () => evaluate<() => void>("home", homeEffect, {
      pathname: "/", effectiveChatId: newChatId, urlChatId: newChatId, localActiveChatId: localChatId,
      switchChatId: (id: string) => state.switchTo(id), contextSetActiveChatId: vi.fn(),
    })();
    sync();
    expect(state.activeChatId).toBe(oldChatId);
    const pending = renderPanel(state.activeChatId, state.messages.get(oldChatId));
    expect(pending.nodes.find(node => node.type === "fieldset").props.disabled).toBe(true);
    await expect(panelSend(state.send, true)("synthetic new command")).rejects.toThrow("正在切换对话");
    await state.streams[0].onUpdate({ type: "text", content: "original stream retained" });
    await state.streams[0].onDone();
    expect(state.isSending).toBe(false);
    expect(state.cancel).not.toHaveBeenCalled();
    expect(state.saves.every(save => save.chatId === oldChatId)).toBe(true);
    expect(state.persisted.get(oldChatId)?.some(item => item.parts?.some((part: any) => part.text === "original stream retained"))).toBe(true);
    sync();
    await Promise.resolve();
    expect(state.activeChatId).toBe(newChatId);
    const ready = renderPanel(state.activeChatId, state.messages.get(newChatId));
    expect(ready.nodes.find(node => node.type === "fieldset").props.disabled).toBe(false);
    expect(ready.nodes.find(node => node.props?.role === "status")).toBeUndefined();
    await panelSend(state.send)("synthetic new command");
    expect(state.streams[1].chatId).toBe(newChatId);
    expect(state.streams[1].conversation).toEqual([]);
    expect(state.messages.get(oldChatId)?.[0]).toBe(state.historic);
  });

  it("rejects a failed user save without starting a stream or clearing another chat", async () => {
    const state = contextHarness();
    state.rejectSave();
    await expect(panelSend(state.send)("synthetic unsaved command")).rejects.toThrow("could not be saved");
    expect(state.streams).toHaveLength(0);
    expect(state.messages.get(oldChatId)).toEqual([state.historic]);
    expect(state.messages.get(newChatId)).toEqual([]);
    expect(state.isSending).toBe(false);
  });

  it("does not allow a request option to redirect a manual send to a different conversation", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    await panelSend(send)("synthetic command", { chatId: oldChatId, headers: { synthetic: "retained" } });
    expect(send).toHaveBeenCalledExactlyOnceWith("synthetic command", {
      chatId: newChatId, headers: { synthetic: "retained" },
    });
  });

  it("waits for the canonical chat before sending a URL draft exactly once", async () => {
    const effect = (find("panel", node => ts.isCallExpression(node) && node.expression.getText(sources.panel) === "useEffect"
      && node.arguments[0].getText(sources.panel).includes("initialMessageToSend?.trim()")) as ts.CallExpression).arguments[0];
    const sent = { current: false };
    const timers: Array<() => void> = [];
    const send = vi.fn().mockResolvedValue(undefined), replace = vi.fn(), switchChatId = vi.fn();
    const base = {
      initialMessageToSend: "synthetic URL command", initialMessageSentRef: sent,
      chatId: newChatId, searchParams: new URLSearchParams({ page: "chat", chatId: newChatId, send: "synthetic URL command" }),
      pathname: "/", router: { replace }, switchChatId, generateUUID: () => localChatId,
      URLSearchParams,
      setTimeout: (timer: () => void) => { timers.push(timer); return timers.length; }, clearTimeout() {},
    };
    evaluate<() => unknown>("panel", effect, { ...base, isChatSwitching: true, sendMessagePresent: panelSend(send, true) })();
    expect(timers).toHaveLength(0);
    expect(sent.current).toBe(false);
    const ready = evaluate<() => unknown>("panel", effect, { ...base, isChatSwitching: false, sendMessagePresent: panelSend(send) });
    ready();
    timers[0]();
    await Promise.resolve();
    await Promise.resolve();
    ready();
    expect(timers).toHaveLength(1);
    expect(send).toHaveBeenCalledExactlyOnceWith({ role: "user", parts: [{ type: "text", text: "synthetic URL command" }] }, { chatId: newChatId });
    expect(switchChatId).not.toHaveBeenCalled();
    const url = new URL(replace.mock.calls[0][0], "http://localhost");
    expect(url.searchParams.get("chatId")).toBe(newChatId);
    expect(url.searchParams.has("send")).toBe(false);
  });

  it("retains the input draft when its canonical user message cannot be saved", async () => {
    const state = contextHarness();
    state.rejectSave();
    const setInput = vi.fn(), setAttachments = vi.fn(), errorToast = vi.fn();
    const submit = evaluate<() => void>("input", callback("input", "submitForm"), {
      input: "synthetic unsaved draft", isUploadingFile: false, attachments: [], selectedModel: "synthetic",
      getBlockedNativeModelAttachmentNames: () => [],
      uploadedRagDocumentsRef: { current: [] }, focusedInsights: [], workspaceFileRefs: [],
      sendMessage: panelSend(state.send), setInput, setAttachments,
      extractRefsFromContent: () => ({ people: [], taskIds: [], channels: [] }),
      setIsAtMentionOpen() {}, setIsSlashOpen() {}, width: 1280, textareaRef: { current: null },
      toast: { warning() {}, error: errorToast }, t: (_key: string, fallback: string) => fallback,
      console: { error() {} },
    });
    submit();
    for (let n = 0; n < 8; n++) await Promise.resolve();
    expect(errorToast).toHaveBeenCalledOnce();
    expect(setInput).not.toHaveBeenCalled();
    expect(setAttachments).not.toHaveBeenCalled();
    expect(state.streams).toHaveLength(0);
  });

  it("reschedules a URL draft after effect cleanup before the timer fires", async () => {
    const effect = (find("panel", node => ts.isCallExpression(node) && node.expression.getText(sources.panel) === "useEffect"
      && node.arguments[0].getText(sources.panel).includes("initialMessageToSend?.trim()")) as ts.CallExpression).arguments[0];
    const sent = { current: false };
    let nextTimer = 0;
    const timers = new Map<number, () => void>();
    const send = vi.fn().mockResolvedValue(undefined), replace = vi.fn();
    const setup = evaluate<() => (() => void) | undefined>("panel", effect, {
      initialMessageToSend: "synthetic URL command", initialMessageSentRef: sent,
      chatId: newChatId, isChatSwitching: false, sendMessagePresent: panelSend(send),
      searchParams: new URLSearchParams({ page: "chat", chatId: newChatId, send: "synthetic URL command" }),
      pathname: "/", router: { replace }, URLSearchParams,
      setTimeout: (timer: () => void) => { const id = ++nextTimer; timers.set(id, timer); return id; },
      clearTimeout: (id: number) => timers.delete(id),
    });
    // StrictMode or a dependency change can perform setup -> cleanup -> setup.
    const cleanup = setup();
    cleanup?.();
    expect(timers.size).toBe(0);
    setup();
    expect(timers.size).toBe(1);
    for (const timer of timers.values()) timer();
    await Promise.resolve();
    await Promise.resolve();
    expect(send).toHaveBeenCalledExactlyOnceWith({ role: "user", parts: [{ type: "text", text: "synthetic URL command" }] }, { chatId: newChatId });
    setup();
    expect(nextTimer).toBe(2);
    expect(replace).toHaveBeenCalledOnce();
  });
});
