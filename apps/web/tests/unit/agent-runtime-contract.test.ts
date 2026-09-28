import { describe, expect, it, vi } from "vitest";
import {
  createLegacyAgentRuntime,
  createPiAgentRuntime,
  type AgentRuntimeRequest,
} from "@openzhiyu/ai/agent/runtime";
import type {
  AgentMessage,
  AgentOptions,
  ExecuteOptions,
  IAgent,
  PlanOptions,
  TaskPlan,
} from "@openzhiyu/ai/agent/types";
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";

async function* oneMessage(message: AgentMessage): AsyncGenerator<AgentMessage> {
  yield message;
}

async function collect(
  generator: AsyncGenerator<AgentMessage>,
): Promise<AgentMessage[]> {
  const messages: AgentMessage[] = [];
  for await (const message of generator) {
    messages.push(message);
  }
  return messages;
}

function createAgentStub() {
  const plan: TaskPlan = {
    id: "plan-1",
    goal: "test",
    steps: [],
    createdAt: new Date("2026-09-13T00:00:00.000Z"),
  };

  const agent: IAgent = {
    provider: "claude",
    run: vi.fn((prompt: string, options?: AgentOptions) =>
      oneMessage({
        type: "text",
        content: `run:${prompt}:${options?.sessionId ?? "none"}`,
      }),
    ),
    plan: vi.fn((prompt: string, options?: PlanOptions) =>
      oneMessage({
        type: "plan",
        content: `plan:${prompt}:${options?.sessionId ?? "none"}`,
        plan,
      }),
    ),
    execute: vi.fn((options: ExecuteOptions) =>
      oneMessage({
        type: "result",
        content: `execute:${options.planId}:${options.sessionId ?? "none"}`,
      }),
    ),
    stop: vi.fn(async () => undefined),
    getPlan: vi.fn((planId: string) => (planId === plan.id ? plan : undefined)),
    deletePlan: vi.fn(),
  };

  return { agent, plan };
}

describe("legacy agent runtime adapter", () => {
  it("routes run requests through the wrapped agent without changing messages", async () => {
    const { agent } = createAgentStub();
    const runtime = createLegacyAgentRuntime(agent);

    const request: AgentRuntimeRequest = {
      operation: "run",
      prompt: "hello",
      options: { sessionId: "session-1" },
    };
    const messages = await collect(runtime.run(request));

    expect(messages).toEqual([
      { type: "text", content: "run:hello:session-1" },
    ]);
    expect(agent.run).toHaveBeenCalledWith("hello", { sessionId: "session-1" });
    expect(runtime.metadata).toMatchObject({
      engine: "claude",
      adapter: "legacy-agent",
    });
  });

  it("routes plan and execute requests through the wrapped agent", async () => {
    const { agent } = createAgentStub();
    const runtime = createLegacyAgentRuntime(agent);

    const planMessages = await collect(
      runtime.run({
        operation: "plan",
        prompt: "make a plan",
        options: { sessionId: "session-2" },
      }),
    );
    const executeMessages = await collect(
      runtime.run({
        operation: "execute",
        options: {
          planId: "plan-1",
          originalPrompt: "make a plan",
          sessionId: "session-2",
        },
      }),
    );

    expect(planMessages[0]?.type).toBe("plan");
    expect(executeMessages).toEqual([
      { type: "result", content: "execute:plan-1:session-2" },
    ]);
    expect(agent.plan).toHaveBeenCalledWith("make a plan", {
      sessionId: "session-2",
    });
    expect(agent.execute).toHaveBeenCalledWith({
      planId: "plan-1",
      originalPrompt: "make a plan",
      sessionId: "session-2",
    });
  });

  it("preserves stop and plan storage semantics", async () => {
    const { agent, plan } = createAgentStub();
    const runtime = createLegacyAgentRuntime(agent);

    await runtime.stop("session-3");
    expect(runtime.getPlan("plan-1")).toBe(plan);
    runtime.deletePlan("plan-1");

    expect(agent.stop).toHaveBeenCalledWith("session-3");
    expect(agent.getPlan).toHaveBeenCalledWith("plan-1");
    expect(agent.deletePlan).toHaveBeenCalledWith("plan-1");
  });
});

describe("pi agent runtime adapter", () => {
  it("maps Pi text streaming events to Zhiyu runtime messages", async () => {
    const faux = createFauxCore({});
    faux.setResponses([fauxAssistantMessage("hello from pi")]);
    const runtime = createPiAgentRuntime({
      model: faux.getModel(),
      streamFn: faux.streamSimple,
    });

    const messages = await collect(
      runtime.run({
        operation: "run",
        prompt: "hello",
        options: { sessionId: "pi-session-1" },
      }),
    );

    expect(
      messages
        .filter((message) => message.type === "text")
        .map((message) => message.content ?? "")
        .join(""),
    ).toBe("hello from pi");
    expect(messages).toContainEqual({
      type: "result",
      content: "hello from pi",
      cost: 0,
    });
    expect(messages.at(-1)).toEqual({ type: "done" });
    expect(runtime.metadata).toMatchObject({
      engine: "pi",
      adapter: "pi-agent-harness",
      version: "0.85.1",
    });
  });

  it("maps Pi tool execution events through injected tools", async () => {
    const faux = createFauxCore({});
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("readFact", { id: "42" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("tool complete"),
    ]);
    const tool: AgentTool = {
      name: "readFact",
      label: "Read fact",
      description: "Read a deterministic fact",
      parameters: Type.Object({ id: Type.String() }),
      execute: async (_toolCallId, params) => {
        const { id } = params as { id: string };
        return {
          content: [{ type: "text", text: `fact:${id}` }],
          details: { id },
        };
      },
    };
    const runtime = createPiAgentRuntime({
      model: faux.getModel(),
      streamFn: faux.streamSimple,
      tools: [tool],
      toolExecution: "sequential",
    });

    const messages = await collect(
      runtime.run({
        operation: "run",
        prompt: "use tool",
        options: { sessionId: "pi-session-2" },
      }),
    );

    expect(messages).toContainEqual({
      type: "tool_use",
      id: expect.any(String),
      name: "readFact",
      input: { id: "42" },
    });
    expect(messages).toContainEqual({
      type: "tool_result",
      toolUseId: expect.any(String),
      output: "fact:42",
      isError: false,
    });
    expect(messages).toContainEqual({
      type: "result",
      content: "tool complete",
      cost: 0,
    });
  });
});
