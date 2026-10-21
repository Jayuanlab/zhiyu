// @vitest-environment jsdom
import { act, createElement, useEffect } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { ChatContextProvider, useChatContext } from "@/components/chat-context";

const state = vi.hoisted(() => ({ params: new URLSearchParams(), nextId: 0 }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => state.params,
  usePathname: () => "/",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("swr", () => ({ default: () => ({}), mutate: vi.fn() }));
vi.mock("@/lib/utils", () => ({
  generateUUID: () => `generated-${++state.nextId}`, buildNavigationUrl: vi.fn(), getTextFromMessage: vi.fn(),
}));
vi.mock("@/components/toast", () => ({ toast: vi.fn() }));
vi.mock("@/lib/ai/router/index", () => ({ streamNativeAgentResponse: vi.fn() }));
vi.mock("@/lib/tauri", () => ({ isTauri: () => false }));
vi.mock("@/components/agent/model-selector", () => ({
  useModelPreference: () => ["default"], getModelConfig: vi.fn(), getPiNativeModelConfig: vi.fn(),
}));
vi.mock("@/lib/ai/chat/save-messages", () => ({ saveMessagesToDatabase: vi.fn() }));
vi.mock("@/lib/auth/token-manager", () => ({ getAuthToken: vi.fn() }));
vi.mock("@/lib/files/tus-upload", () => ({ uploadImageTUS: vi.fn() }));
vi.mock("@/lib/env/constants", () => ({ DEFAULT_AI_MODEL: "test", AI_PROXY_BASE_URL: "" }));
vi.mock("@/lib/ai/runtime/format-error", () => ({ formatAgentStreamErrorForUser: vi.fn() }));
vi.mock("@/lib/ai/native-agent-plan-part", () => ({ nativeAgentPlanToPart: vi.fn() }));

const urlChat = "11111111-1111-4111-8111-111111111111";
const savedChat = "22222222-2222-4222-8222-222222222222";
const mounted: Root[] = [];
let consoleError: MockInstance<typeof console.error>;

function Probe({ initialIds, startOnMount = false }: {
  initialIds: Array<string | null>; startOnMount?: boolean;
}) {
  const context = useChatContext();
  useEffect(() => {
    initialIds.push(context.activeChatId);
    if (startOnMount) context.setIsAgentRunning(true, urlChat);
  }, []);
  // This is the actual AgentChatPanel switching predicate, with its two DOM roots.
  const switching = context.activeChatId !== (state.params.get("chatId") || context.activeChatId);
  return createElement(switching ? "p" : "div", {
    "data-chat": context.activeChatId, "data-running": context.isAgentRunning,
  },
    `${switching ? "switching" : "messages"}:${context.focusedInsights.length}`);
}

async function hydrateChat(startOnMount = false) {
  const initialIds: Array<string | null> = [];
  const tree = createElement(ChatContextProvider, null, createElement(Probe, { initialIds, startOnMount }));
  const browserWindow = window;
  vi.stubGlobal("window", undefined);
  let html: string;
  try { html = renderToString(tree); } finally { vi.stubGlobal("window", browserWindow); }
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.append(container);
  const errors: unknown[] = [];
  await act(async () => {
    mounted.push(hydrateRoot(container, tree, { onRecoverableError: error => errors.push(error) }));
  });
  return { html, container, errors, initialIds };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  state.params = new URLSearchParams({ page: "chat", chatId: urlChat });
  state.nextId = 0;
  localStorage.clear();
});
afterEach(async () => {
  await act(async () => { mounted.splice(0).forEach(root => root.unmount()); });
  document.body.replaceChildren();
  // Attribute-only hydration differences may warn without onRecoverableError.
  const hydrationWarnings = consoleError.mock.calls.filter(args =>
    args.some(arg => typeof arg === "string" && /hydrat|server rendered/i.test(arg)));
  consoleError.mockRestore();
  vi.unstubAllGlobals();
  expect(hydrationWarnings).toEqual([]);
});

describe("chat context server/client first render", () => {
  it("hydrates the canonical URL chat when storage already selects that chat", async () => {
    localStorage.setItem("activeChatId", urlChat);
    const result = await hydrateChat();
    expect(result.errors).toEqual([]);
    expect(result.html).toContain("messages:0");
    expect(result.initialIds).toEqual([urlChat]);
    expect(result.container.firstElementChild?.getAttribute("data-chat")).toBe(urlChat);
  });

  it("keeps the URL authoritative over a different saved chat and restores focus after hydration", async () => {
    localStorage.setItem("activeChatId", savedChat);
    localStorage.setItem("chatSessionStates", JSON.stringify({
      [urlChat]: { isAgentRunning: false, focusedInsights: [{ id: "saved-focus" }] },
    }));
    const result = await hydrateChat();
    expect(result.errors).toEqual([]);
    expect(result.html).toContain("messages:0");
    expect(result.container.firstElementChild?.getAttribute("data-chat")).toBe(urlChat);
    expect(result.container.textContent).toBe("messages:1");
  });

  it("restores a saved chat after a deterministic first render when the URL has no chat", async () => {
    state.params = new URLSearchParams();
    localStorage.setItem("activeChatId", savedChat);
    const result = await hydrateChat();
    expect(result.errors).toEqual([]);
    expect(result.initialIds).toEqual([null]);
    expect(result.container.firstElementChild?.getAttribute("data-chat")).toBe(savedChat);
  });

  it("creates a fresh conversation only after hydration when no preference exists", async () => {
    state.params = new URLSearchParams();
    const result = await hydrateChat();
    expect(result.errors).toEqual([]);
    expect(result.initialIds).toEqual([null]);
    expect(result.container.firstElementChild?.getAttribute("data-chat")).toBe("generated-1");
  });

  it("does not overwrite a run started by a child mount effect with cached UI state", async () => {
    localStorage.setItem("chatSessionStates", JSON.stringify({
      [urlChat]: { isAgentRunning: false, focusedInsights: [] },
    }));
    const result = await hydrateChat(true);
    expect(result.errors).toEqual([]);
    expect(result.container.firstElementChild?.getAttribute("data-running")).toBe("true");
  });
});
