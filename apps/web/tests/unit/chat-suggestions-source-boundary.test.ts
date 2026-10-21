import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  session: { user: { id: "synthetic-owner-a" } } as { user: { id?: string } } | null,
  readInsights: vi.fn(), readBots: vi.fn(), readRoles: vi.fn(), readSettings: vi.fn(), readSurvey: vi.fn(),
  generateText: vi.fn(), modelProvider: vi.fn(), userContext: vi.fn(),
}));
vi.mock("@/app/(auth)/auth", () => ({ auth: vi.fn(async () => mocks.session) }));
vi.mock("@/lib/db/insight-queries", () => ({
  getStoredInsightsByBotIds: mocks.readInsights, getUserRoles: mocks.readRoles, getUserInsightSettings: mocks.readSettings,
}));
vi.mock("@/lib/db/bot-queries", () => ({ getBotsByUserId: mocks.readBots }));
vi.mock("@/lib/db/user-queries", () => ({ getLatestSurveyByUserId: mocks.readSurvey }));
vi.mock("ai", () => ({ generateText: mocks.generateText }));
vi.mock("@/lib/ai", () => ({ getModelProvider: mocks.modelProvider }));
vi.mock("@/lib/ai/request-context", () => ({ setAIUserContextFromRequest: mocks.userContext }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key }) }));
vi.mock("framer-motion", () => ({ motion: { div: ({ children }: { children?: ReactNode }) => createElement("div", {}, children) } }));
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children?: ReactNode }) => createElement("a", { href }, children) }));
vi.mock("@/components/chat-context", () => ({ useChatContextOptional: () => ({ activeChatId: "synthetic-chat", focusedInsights: [] }) }));
vi.mock("@/components/remix-icon", () => ({ RemixIcon: () => null }));

import { GET } from "@/app/(chat)/api/chat/suggestions/route";
import { Greeting } from "@/components/greeting";
import { CHAT_SUGGESTIONS_SOURCE_WARNING } from "@/lib/ai/chat-suggestions-policy";

describe("automatic Web suggestions source boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.session = { user: { id: "synthetic-owner-a" } };
    // If this route regresses, these are private sentinels, never real records.
    mocks.readInsights.mockResolvedValue({ insights: [{ description: "PRIVATE_OLD_INSIGHT_SENTINEL" }] });
    mocks.readRoles.mockResolvedValue([{ roleKey: "PRIVATE_PROFILE_SENTINEL" }]);
    mocks.readSettings.mockResolvedValue({ focusTopics: ["PRIVATE_SETTINGS_SENTINEL"] });
    mocks.readSurvey.mockResolvedValue({ workDescription: "PRIVATE_SURVEY_SENTINEL" });
  });
  afterEach(() => {
    for (const read of [mocks.readInsights, mocks.readBots, mocks.readRoles, mocks.readSettings, mocks.readSurvey,
      mocks.generateText, mocks.modelProvider, mocks.userContext]) expect(read).not.toHaveBeenCalled();
  });

  it("returns usable fixed suggestions without reading stored source bodies or invoking any provider", async () => {
    const response = await GET(new Request("http://localhost/api/chat/suggestions"));
    const data = await response.json();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(data).toMatchObject({ provider: "fixed", detail: "personalized_sources_withheld", warning: CHAT_SUGGESTIONS_SOURCE_WARNING,
      sourceProtection: { status: "withheld", reason: "source_unregistered", storedSourcesRead: false, modelInvoked: false, historicalDerivationsUsed: false } });
    expect(data.suggested_prompts).toHaveLength(3);
    expect(data.suggested_prompts.every((item: { title: string; related_insight_ids: string[] }) => item.title && item.related_insight_ids.length === 0)).toBe(true);
    expect(JSON.stringify(data)).not.toContain("PRIVATE_");
  });

  it("isolates owners by returning only the same public fixed payload", async () => {
    const first = await (await GET(new Request("http://localhost/api/chat/suggestions?owner=other"))).json();
    mocks.session = { user: { id: "synthetic-owner-b" } };
    const second = await (await GET(new Request("http://localhost/api/chat/suggestions"))).json();
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).not.toContain("synthetic-owner");
  });

  it.each([null, { user: {} }])("requires an actual authenticated owner: %j", async session => {
    mocks.session = session;
    const response = await GET(new Request("http://localhost/api/chat/suggestions"));
    expect(response.status).toBe(401);
  });

  it("shows the protection status alongside the real desktop suggestion cards", () => {
    const html = renderToStaticMarkup(createElement(Greeting, { chatId: "synthetic-chat" }));
    expect(html).toContain('data-testid="suggested-actions"');
    expect(html).toContain('role="status"');
    expect(html).toContain(CHAT_SUGGESTIONS_SOURCE_WARNING);
    expect(html.match(/type="button"/g)).toHaveLength(4);
    expect(html).not.toContain("PRIVATE_");
  });
});
