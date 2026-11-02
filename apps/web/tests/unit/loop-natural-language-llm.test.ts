import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/user-llm-api-settings", () => ({
  getUserLlmProviderConfig: vi.fn(async () => undefined),
}));

import { draftLoopFromNaturalLanguage } from "@/lib/loops/natural-language";

describe("natural language loop LLM parser", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.LOOP_NL_LLM_API_KEY = "test-key";
    process.env.LOOP_NL_LLM_BASE_URL = "https://llm.example.test/v1";
    process.env.LOOP_NL_LLM_MODEL = "fast-parser-model";
    process.env.LOOP_NL_LLM_TIMEOUT_MS = "12345";
    process.env.LOOP_NL_LLM_MAX_TOKENS = "321";
    process.env.LOOP_NL_LLM_JSON_MODE = "0";
    process.env.LOOP_NL_RULE_PARSER = undefined;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env.LOOP_NL_LLM_API_KEY = undefined;
    process.env.LOOP_NL_LLM_BASE_URL = undefined;
    process.env.LOOP_NL_LLM_MODEL = undefined;
    process.env.LOOP_NL_LLM_TIMEOUT_MS = undefined;
    process.env.LOOP_NL_LLM_MAX_TOKENS = undefined;
    process.env.LOOP_NL_LLM_JSON_MODE = undefined;
    process.env.LOOP_NL_RULE_PARSER = undefined;
  });

  it("uses the compact dedicated LLM request by default", async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                name: "Daily weather",
                description: "Send Beijing weather every morning",
                goal: "每天早上9点给文件传输助手发送北京天气预报",
                schedule: {
                  type: "cron",
                  cronExpression: "0 9 * * *",
                  timezone: "Asia/Shanghai",
                  label: "每天 09:00",
                },
                taskKind: "weather_wechat_delivery",
                contextInstructions: "Fetch Beijing weather and send it.",
                weather: { city: "北京", date: "today" },
                delivery: {
                  platform: "wechat_desktop",
                  recipientName: "文件传输助手",
                  sendMode: "loop_approved",
                },
                missingFields: [],
                allowedActions: ["getWeather"],
                requiredApprovalActions: [],
                successCriteria: ["sent"],
              }),
            },
          },
        ],
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const draft = await draftLoopFromNaturalLanguage({
      userId: "user-1",
      intent: "每天早上9点给文件传输助手发送北京天气预报",
      timezone: "Asia/Shanghai",
      externalWriteMode: "loop_approved",
    });

    expect(draft.planner).toMatchObject({
      model: "fast-parser-model",
      parser: "local_llm_api",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const request = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(String(request.body));
    expect(body).toMatchObject({
      model: "fast-parser-model",
      max_tokens: 321,
      stream: false,
    });
    expect(body.response_format).toBeUndefined();
    expect(body.messages[1].content).toContain("Keys:");
    expect(body.messages[1].content).not.toContain("Required JSON shape");
  });

  it("normalizes trading-day pre-open watchlists locally", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const draft = await draftLoopFromNaturalLanguage({
      userId: "user-1",
      workshopId: "workshop-1",
      intent: "每个交易日开盘前生成关注列表",
      timezone: "Asia/Shanghai",
      externalWriteMode: "manual_approval",
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(draft.planner).toMatchObject({
      model: "local-rules",
      parser: "local_rules",
    });
    expect(draft.name).toBe("交易日盘前关注列表");
    expect(draft.extracted.scheduleLabel).toBe("每个交易日 09:00");
    expect(draft.spec.trigger).toEqual({
      type: "cron",
      expression: "0 9 * * 1-5",
      timezone: "Asia/Shanghai",
      tradingCalendar: "a-share",
      tradingDayOnly: true,
    });
    expect(draft.spec.approval.defaultMode).toBe("require_approval");
  });

  it("normalizes interval owner-context memory processing locally", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const draft = await draftLoopFromNaturalLanguage({
      userId: "user-1",
      workshopId: "workshop-1",
      intent:
        "每 5 分钟检查微信来源的新消息并处理个人记忆，提取主人知识库候选并审核证据",
      timezone: "Asia/Shanghai",
      externalWriteMode: "manual_approval",
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(draft.planner).toMatchObject({
      model: "local-rules",
      parser: "local_rules",
    });
    expect(draft.name).toBe("主人知识库定时处理");
    expect(draft.extracted.scheduleLabel).toBe("每 5 分钟");
    expect(draft.spec.trigger).toEqual({
      type: "interval",
      minutes: 5,
    });
    expect(draft.spec.actions.allowed).toContain(
      "ownerContextProcessRecordedMessages",
    );
    expect(draft.spec.actions.requiresApproval).toContain(
      "wechatDesktopSendMessage",
    );
    expect(draft.spec.context.instructions).toContain(
      "ownerContextListCandidates",
    );
  });
});
vi.mock("@/lib/ai/model-center-store",()=>({readModelCenterSnapshot:async()=>null}));
