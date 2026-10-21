import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig, AgentOptions, TaskPlan } from "@openzhiyu/ai/agent/types";
import { hasMemoryModelScope } from '@/lib/memory/context/model-source-scope';
import { MemoryModuleError } from '@/lib/memory/kernel/errors';

const mocks = vi.hoisted(() => {
  const savedPlans = new Map<string, { plan: TaskPlan; renderedPrompt: string; taskId: string | null; workDir: string | null; userId: string }>();
  const executionOrder: string[] = [];
  const version = `mplan1:${'1'.repeat(64)}`;
  const flags = { failPrepare: false, failFinish: false };
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
  const createAgent = vi.fn((config: AgentConfig) => ({
    provider: "pi",
    plan: vi.fn(async function* (prompt: string) {
      yield { type: "text", content: `planning:${prompt.includes("hello attachment")}` };
      yield { type: "plan", plan, content: "plan ready" };
      yield { type: "done" };
    }),
    execute: vi.fn(async function* (input: AgentOptions & { planId: string; originalPrompt?: string }) {
      executionOrder.push('execute');
      input.onRuntimeSelected?.({ engine: config.provider === 'claude' ? 'claude' : 'pi', adapter: config.provider === 'claude' ? 'claude-sdk-controlled-http' : 'pi-agent-harness', version: 'synthetic' });
      await input.onBeforeProviderRequest?.(); executionOrder.push('provider');
      yield {
        type: "result",
        content: `executed:${input.planId}:${input.originalPrompt?.includes(
          "hello attachment",
        )}`,
      };
      yield { type: 'runtime_terminal', runtimeTerminal: { schemaVersion: 'agent-runtime-terminal.v1', status: 'completed', cleanupStatus: 'completed' } };
      yield { type: "done" };
    }),
    run: vi.fn(async function* (prompt: string, _options: AgentOptions) {
      _options.onRuntimeSelected?.({ engine: config.provider === 'claude' ? 'claude' : 'pi', adapter: config.provider === 'claude' ? 'claude-sdk-controlled-http' : 'pi-agent-harness', version: 'synthetic' });
      await _options.onBeforeProviderRequest?.();
      if (prompt.includes("permission probe")) {
        const decision = await _options.onPermissionRequest!({
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
  return { createAgent, plan, savedPlans, executionOrder, version, flags };
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

vi.mock("@/lib/ai/native-pi-web-chat-tools", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/ai/native-pi-web-chat-tools")>(),
  NATIVE_PI_WEB_CHAT_TOOLS: ["time", "webSearch", "platformRecall"],
  createNativePiWebChatTools: vi.fn(() => [
    { name: "time" },
    { name: "webSearch" },
    { name: "platformRecall" },
  ]),
}));

vi.mock("@/lib/memory/plans/service", () => ({
  saveGeneratedMemoryPlan: vi.fn(async (input) => {
    expect(hasMemoryModelScope()).toBe(true);
    const record = {
      plan: input.plan,
      renderedPrompt: input.renderedPrompt,
      workDir: input.workDir ?? null,
      taskId: input.taskId ?? null,
      userId: input.userId,
    };
    mocks.savedPlans.set(input.plan.id, record);
    return { ...record, version: mocks.version, revision: 1, state: 'ready', origin: 'generated', receiptId: 'synthetic-plan-receipt', sourceCount: 1,
      expiresAt: '2099-01-01T00:00:00Z', historicalSources: 'captured_at_generation' };
  }),
  getMemoryPlanForExecution: vi.fn(async (input) => {
    mocks.executionOrder.push('preflight');
    const record = mocks.savedPlans.get(input.planId);
    if (!record || record.userId !== input.userId) throw new MemoryModuleError('memory_plan_unavailable', 404, 'Plan unavailable');
    if (input.expectedVersion !== mocks.version || record.workDir !== input.workDir || record.taskId !== input.taskId)
      throw new MemoryModuleError('memory_plan_revision_conflict', 409, 'Plan changed');
    return { plan: record.plan, version: mocks.version };
  }),
  prepareMemoryPlanExecution: vi.fn(async (input) => {
    expect(hasMemoryModelScope()).toBe(true); mocks.executionOrder.push('prepare');
    if (mocks.flags.failPrepare) throw new MemoryModuleError('memory_source_unavailable', 503, 'Plan source audit failed');
    const record = mocks.savedPlans.get(input.planId);
    if (!record) throw new MemoryModuleError('memory_plan_unavailable', 404, 'Plan unavailable');
    return { plan: record.plan, originalPrompt: record.renderedPrompt, version: mocks.version };
  }),
  finishMemoryPlanExecution: vi.fn(async (input) => {
    expect(hasMemoryModelScope()).toBe(true); mocks.executionOrder.push(`finish:${input.status}`);
    if (mocks.flags.failFinish) throw new MemoryModuleError('memory_plan_feedback_unavailable', 503, 'Execution feedback unavailable');
    return { status: input.status };
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
    mocks.executionOrder.length = 0; mocks.flags.failPrepare = false; mocks.flags.failFinish = false;
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'synthetic-env-token'); vi.stubEnv('ANTHROPIC_API_KEY', 'synthetic-env-token');
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://synthetic-env-provider.invalid'); vi.stubEnv('ANTHROPIC_MODEL', 'synthetic-env-model');
    vi.stubEnv('LLM_API_KEY', 'synthetic-pi-key'); vi.stubEnv('LLM_BASE_URL', 'https://synthetic-pi-provider.invalid'); vi.stubEnv('LLM_MODEL', 'synthetic-pi-model');
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

  it("persists source lineage before exposing a plan and prepares its approved sources before actual execution", async () => {
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
    expect(planMessages.find(message => message.type === 'plan').sourceLineage).toMatchObject({ version: mocks.version, sourceCount: 1 });
    expect(mocks.savedPlans.get("route-plan-1")?.renderedPrompt).not.toContain("hello attachment");
    expect(mocks.savedPlans.get("route-plan-1")?.renderedPrompt).toContain(
      "memory_source_unregistered",
    );

    const executeResponse = await POST(
      request({
        ...baseBody,
        phase: "execute",
        planId: "route-plan-1",
        planVersion: mocks.version,
        planCommandId: '11111111-1111-4111-8111-111111111111',
      }) as never,
    );

    expect(executeResponse.status).toBe(200);
    const executed = await sseMessages(executeResponse);
    expect(executed).toContainEqual(expect.objectContaining({ type: 'result', content: 'executed:route-plan-1:false' }));
    expect(mocks.executionOrder).toEqual(['preflight', 'prepare', 'execute', 'provider', 'finish:completed']);
    expect(mocks.createAgent.mock.results.every(result => !result.value.getPlan.mock.calls.length)).toBe(true);
  });

  it('rejects a stale approval version and source-audit failure before constructing execute', async () => {
    const { POST } = await import('@/app/api/native/agent/route');
    mocks.savedPlans.set(mocks.plan.id, { plan: mocks.plan, renderedPrompt: 'SOURCE_CHECKED_PLAN_PROMPT', taskId: null, workDir: null, userId: 'owner-route' });
    const body = { provider: 'pi', phase: 'execute', prompt: 'Approve', planId: mocks.plan.id, planVersion: `mplan1:${'2'.repeat(64)}`, planCommandId: '11111111-1111-4111-8111-111111111111' };
    const conflict = await POST(request(body) as never); expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: 'memory_plan_revision_conflict' });
    mocks.flags.failPrepare = true;
    const response = await POST(request({ ...body, planVersion: mocks.version }) as never);
    expect(response.status).toBe(200); expect(await sseMessages(response)).toContainEqual(expect.objectContaining({ type: 'error', code: 'memory_source_unavailable' }));
    expect(mocks.createAgent.mock.results.every(result => !result.value.execute.mock.calls.length)).toBe(true);
  });

  it('mounts controlled Claude host tools without trusting request-body endpoint or credentials', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'server-provider-key'); vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'server-provider-key'); vi.stubEnv('ANTHROPIC_BASE_URL', 'https://synthetic-server-provider.invalid');
    const { POST } = await import('@/app/api/native/agent/route');
    const response = await POST(request({ provider: 'claude', prompt: 'Synthetic controlled text', allowedTools: ['time'],
      modelConfig: { model: 'claude-sonnet-4-6', apiKey: 'untrusted-request-key', baseUrl: 'http://forbidden.invalid' } }) as never);
    expect(response.status).toBe(200); await sseMessages(response);
    expect(mocks.createAgent.mock.calls[0]![0]).toMatchObject({ provider: 'claude', apiKey: 'server-provider-key', baseUrl: 'https://synthetic-server-provider.invalid' });
    expect(mocks.createAgent.mock.results[0]!.value.run.mock.calls[0]![1]).toMatchObject({ allowedTools: [], runtimeTools: [{ name: 'time' }], mcpConfig: undefined, sandbox: undefined });
  });

  it('withholds the completed terminal if durable execution feedback fails', async () => {
    const { POST } = await import('@/app/api/native/agent/route'); mocks.flags.failFinish = true;
    mocks.savedPlans.set(mocks.plan.id, { plan: mocks.plan, renderedPrompt: 'SOURCE_CHECKED_PLAN_PROMPT', taskId: null, workDir: null, userId: 'owner-route' });
    const response = await POST(request({ provider: 'pi', phase: 'execute', prompt: 'Approve', planId: mocks.plan.id,
      planVersion: mocks.version, planCommandId: '11111111-1111-4111-8111-111111111111' }) as never);
    const messages = await sseMessages(response);
    expect(messages).toContainEqual(expect.objectContaining({ type: 'error', code: 'memory_plan_feedback_unavailable' }));
    expect(messages.some(message => message.type === 'runtime_terminal' && message.runtimeTerminal?.status === 'completed')).toBe(false);
    expect(mocks.executionOrder).toEqual(['preflight', 'prepare', 'execute', 'provider', 'finish:completed']);
  });

  it("refuses an unsupported SDK runtime before creating its model or filesystem tools", async () => {
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

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: 'memory_source_runtime_unsupported' });
    expect(mocks.createAgent).not.toHaveBeenCalled();
  });
});
