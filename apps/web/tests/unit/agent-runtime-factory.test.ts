import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import {
  AgentRuntimeUnavailableError,
  createAgentRuntime,
  resolveAgentRuntimeEngine,
} from "@/lib/ai/runtime/agent-factory";
import { createPiRuntimeOptionsFromModelConfig } from "@openzhiyu/ai/agent/runtime";
import type {
  AgentMessage,
  AgentOptions,
  ExecuteOptions,
  IAgent,
  PlanOptions,
  TaskPlan,
} from "@openzhiyu/ai/agent/types";
import { describe, expect, it, vi } from "vitest";

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

function createAgentStub(): IAgent {
  return {
    provider: "claude",
    run: vi.fn((prompt: string, options?: AgentOptions) =>
      oneMessage({
        type: "text",
        content: `${prompt}:${options?.sessionId ?? "none"}`,
      }),
    ),
    plan: vi.fn((_prompt: string, _options?: PlanOptions) =>
      oneMessage({ type: "done" }),
    ),
    execute: vi.fn((_options: ExecuteOptions) =>
      oneMessage({ type: "done" }),
    ),
    stop: vi.fn(async () => undefined),
    getPlan: vi.fn((_planId: string): TaskPlan | undefined => undefined),
    deletePlan: vi.fn(),
  };
}

describe("agent runtime factory", () => {
  it("defaults to the Claude runtime", async () => {
    const createClaudeAgentOverride = vi.fn(() => createAgentStub());
    const runtime = createAgentRuntime({
      claudeConfig: { provider: "claude", model: "test-model" },
      createClaudeAgentOverride,
    });

    expect(runtime.metadata).toMatchObject({
      engine: "claude",
      adapter: "claude-agent-sdk",
    });
    expect(createClaudeAgentOverride).toHaveBeenCalledWith({
      provider: "claude",
      model: "test-model",
    });

    const messages = await collect(
      runtime.run({
        operation: "run",
        prompt: "hello",
        options: { sessionId: "factory-session" },
      }),
    );
    expect(messages).toEqual([
      { type: "text", content: "hello:factory-session" },
    ]);
  });

  it("fails explicitly when Pi is requested without options", () => {
    expect(() =>
      createAgentRuntime({
        engine: "pi",
        claudeConfig: { provider: "claude" },
        createClaudeAgentOverride: vi.fn(() => createAgentStub()),
      }),
    ).toThrow(AgentRuntimeUnavailableError);
  });

  it("creates a Pi runtime when Pi options are provided", async () => {
    const faux = createFauxCore({});
    faux.setResponses([fauxAssistantMessage("pi ready")]);
    const runtime = createAgentRuntime({
      engine: "pi",
      claudeConfig: { provider: "claude" },
      pi: {
        model: faux.getModel(),
        streamFn: faux.streamSimple,
      },
      createClaudeAgentOverride: vi.fn(() => createAgentStub()),
    });

    expect(runtime.metadata.engine).toBe("pi");
    const messages = await collect(
      runtime.run({
        operation: "run",
        prompt: "hello",
      }),
    );
    expect(messages).toContainEqual({
      type: "result",
      content: "pi ready",
      cost: 0,
    });
  });

  it("accepts Pi runtime options resolved from model config", () => {
    const runtime = createAgentRuntime({
      engine: "pi",
      claudeConfig: { provider: "claude" },
      pi: createPiRuntimeOptionsFromModelConfig({
        apiKey: "test-key",
        baseUrl: "https://api.anthropic.com",
        model: "claude-sonnet-test",
      }),
      createClaudeAgentOverride: vi.fn(() => createAgentStub()),
    });

    expect(runtime.metadata).toMatchObject({
      engine: "pi",
      adapter: "pi-agent-harness",
      version: "0.85.1",
    });
  });

  it("rejects unknown engine names", () => {
    expect(() => resolveAgentRuntimeEngine("other")).toThrow(
      AgentRuntimeUnavailableError,
    );
  });
});
