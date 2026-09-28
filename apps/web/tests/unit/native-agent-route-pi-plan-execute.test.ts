import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskPlan } from "@openzhiyu/ai/agent/types";

const mocks = vi.hoisted(() => {
  const savedPlans = new Map<string, any>();
  const plan: TaskPlan = {
    id: "route-plan-1",
    goal: "Summarize attached context",
    steps: [
      {
        id: "step-1",
        description: "Read the provided text context",
        status: "pending",
      },
    ],
    createdAt: new Date("2026-09-15T00:00:00.000Z"),
  };
  const createAgent = vi.fn(() => ({
    provider: "pi",
    plan: vi.fn(async function* (prompt: string) {
      yield { type: "text", content: `planning:${prompt.includes("hello attachment")}` };
      yield { type: "plan", plan, content: "plan ready" };
      yield { type: "done" };
    }),
    execute: vi.fn(async function* (input: {
      planId: string;
      originalPrompt?: string;
    }) {
      yield {
        type: "result",
        content: `executed:${input.planId}:${input.originalPrompt?.includes(
          "hello attachment",
        )}`,
      };
      yield { type: "done" };
    }),
    run: vi.fn(async function* (prompt: string, _options: any) {
      if (prompt.includes("permission probe")) {
        const decision = await _options.onPermissionRequest({
          toolName: "platformRecall",
          toolInput: { sections: ["registry"] },
          toolUseID: "tool-platform-recall-1",
        });
        yield {
          type: "result",
          content: `permission:${decision.behavior}`,
        };
      }
      yield { type: "done" };
    }),
    getPlan: vi.fn(() => undefined),
    deletePlan: vi.fn(),
    stop: vi.fn(),
  }));
  return { createAgent, plan, savedPlans };
});

vi.mock("@/app/(auth)/auth", () => ({
  auth: vi.fn(async () => ({ user: { id: "owner-route" } })),
}));

vi.mock("@openzhiyu/ai/agent/registry", () => ({
  getAgentRegistry: () => ({
    register: vi.fn(),
    create: mocks.createAgent,
  }),
}));

vi.mock("@/lib/ai/extensions", () => ({
  claudePlugin: { name: "claude" },
  piPlugin: { name: "pi" },
}));

vi.mock("@/lib/db/chat-queries", () => ({
  getMessagesByChatId: vi.fn(async () => []),
}));

vi.mock("@/lib/db/insight-queries", () => ({
  getUserInsightSettings: vi.fn(async () => ({ language: "en" })),
}));

vi.mock("@/lib/ai/user-llm-api-settings", () => ({
  getUserLlmProviderConfig: vi.fn(async () => undefined),
}));

vi.mock("@/lib/loops", () => ({
  resolveChatLoopGuardContext: vi.fn(async () => null),
  withNativeAgentLoopGuardMetadata: vi.fn(({ request }) => request),
}));

vi.mock("@/lib/ai/skills/loader", () => ({
  loadSkills: vi.fn(() => []),
  getSkillContent: vi.fn(() => null),
}));

vi.mock("@/lib/ai/native-pi-web-chat-tools", () => ({
  NATIVE_PI_WEB_CHAT_TOOLS: ["time", "webSearch", "platformRecall"],
  createNativePiWebChatTools: vi.fn(() => [
    { name: "time" },
    { name: "webSearch" },
    { name: "platformRecall" },
  ]),
}));

vi.mock("@/lib/ai/native-agent-plan-store", () => ({
  saveNativeAgentPlan: vi.fn(async (input) => {
    const record = {
      plan: input.plan,
      originalPrompt: input.originalPrompt,
      workDir: input.workDir,
      taskId: input.taskId,
      ownerId: input.ownerId,
    };
    mocks.savedPlans.set(input.plan.id, record);
    return record;
  }),
  lookupStoredNativeAgentPlan: vi.fn(async (input) => {
    const record = mocks.savedPlans.get(input.planId);
    if (!record) return { state: "missing" };
    if (record.ownerId !== input.ownerId) return { state: "owner_mismatch" };
    if (record.workDir && input.workDir && record.workDir !== input.workDir) {
      return {
        state: "workdir_mismatch",
        expected: record.workDir,
        actual: input.workDir,
      };
    }
    return { state: "found", record };
  }),
}));

function request(body: Record<string, unknown>) {
  return new Request("http://localhost/api/native/agent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function sseMessages(response: Response) {
  const text = await response.text();
  return text
    .split("\n\n")
    .filter((chunk) => chunk.startsWith("data: "))
    .map((chunk) => JSON.parse(chunk.slice("data: ".length)));
}

describe("native agent route Pi plan/execute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.savedPlans.clear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("enforces explicit Pi tool allowlists both in the guard and model-visible tools", async () => {
    const { POST } = await import("@/app/api/native/agent/route");
    const { createNativePiWebChatTools } = await import("@/lib/ai/native-pi-web-chat-tools");
    for (const allowedTools of [["time"], []]) {
      const response = await POST(request({ provider: "pi", prompt: "Read only", allowedTools }) as never);
      expect(response.status).toBe(200);
      await sseMessages(response);
      expect(createNativePiWebChatTools).toHaveBeenLastCalledWith(expect.objectContaining({
        policy: { allowedTools, defaultDecision: "deny" },
      }));
      const agent = mocks.createAgent.mock.results.at(-1)!.value;
      expect(agent.run.mock.calls[0][1].runtimeTools.map((tool: any) => tool.name)).toEqual(allowedTools);
      expect(agent.run.mock.calls[0][0].includes("platformRecall")).toBe(
        allowedTools.includes("platformRecall"),
      );
    }
  });

  it("injects platform recall guidance when the read-only tool is available", async () => {
    const { POST } = await import("@/app/api/native/agent/route");
    const response = await POST(
      request({
        provider: "pi",
        prompt: "Explain the current memory architecture.",
      }) as never,
    );

    expect(response.status).toBe(200);
    await sseMessages(response);
    const agent = mocks.createAgent.mock.results.at(-1)!.value;
    const prompt = agent.run.mock.calls[0][0];
    expect(prompt).toContain("platformRecall");
    expect(prompt).toContain("Use platformRecall before answering questions");
    expect(prompt).toContain("current Work, Loop, grant, or tool-capability");
  });

  it("auto-allows Pi read-only runtime tools without waiting for a frontend permission response", async () => {
    const { POST } = await import("@/app/api/native/agent/route");
    const response = await POST(
      request({
        provider: "pi",
        prompt: "permission probe",
        allowedTools: ["platformRecall"],
      }) as never,
    );

    expect(response.status).toBe(200);
    const messages = await sseMessages(response);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "result",
          content: "permission:allow",
        }),
        expect.objectContaining({ type: "done" }),
      ]),
    );
  });

  it("streams plan then executes a stored Pi plan with read-only text attachment context", async () => {
    const { POST } = await import("@/app/api/native/agent/route");
    const baseBody = {
      provider: "pi",
      modelConfig: {
        apiKey: "test-key",
        baseUrl: "https://opencode.ai/zen/go",
        model: "qwen3.7-plus",
      },
      workDir: "D:/zhiyu",
      prompt: "Use the attached text and make a plan.",
      fileAttachments: [
        {
          name: "notes.txt",
          mimeType: "text/plain",
          data: `data:text/plain;base64,${Buffer.from(
            "hello attachment",
          ).toString("base64")}`,
        },
      ],
    };

    const planResponse = await POST(
      request({ ...baseBody, phase: "plan" }) as never,
    );

    expect(planResponse.status).toBe(200);
    expect(planResponse.headers.get("Content-Type")).toContain(
      "text/event-stream",
    );
    const planMessages = await sseMessages(planResponse);
    expect(planMessages.map((message) => message.type)).toContain("plan");
    expect(mocks.savedPlans.get("route-plan-1")?.originalPrompt).toContain(
      "hello attachment",
    );
    expect(mocks.savedPlans.get("route-plan-1")?.originalPrompt).toContain(
      "have not been saved to the workspace",
    );

    const executeResponse = await POST(
      request({
        ...baseBody,
        phase: "execute",
        planId: "route-plan-1",
      }) as never,
    );

    expect(executeResponse.status).toBe(200);
    const executeMessages = await sseMessages(executeResponse);
    expect(executeMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "result",
          content: "executed:route-plan-1:true",
        }),
        expect.objectContaining({ type: "done" }),
      ]),
    );
  });

  it("falls back to Claude when default Pi cannot handle an unsupported capability and Claude config exists", async () => {
    vi.stubEnv("NATIVE_AGENT_DEFAULT_PROVIDER", "pi");
    vi.stubEnv("ANTHROPIC_API_KEY", "test-claude-key");

    const { POST } = await import("@/app/api/native/agent/route");

    const response = await POST(
      request({
        modelConfig: {
          model: "claude-sonnet-4.6",
        },
        workDir: "D:/zhiyu",
        prompt: "Use the attached image if available.",
        images: [
          {
            name: "chart.png",
            type: "image/png",
            data: "data:image/png;base64,aGVsbG8=",
          },
        ],
      }) as never,
    );

    expect(response.status).toBe(200);
    expect(mocks.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "claude",
        model: "claude-sonnet-4.6",
      }),
    );
    const messages = await sseMessages(response);
    expect(messages).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "done" })]),
    );
  });
});
