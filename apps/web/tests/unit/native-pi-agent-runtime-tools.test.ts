import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const run = vi.fn(async function* () {
    yield { type: "done" };
  });
  const stop = vi.fn();
  const createPiAgentRuntime = vi.fn(() => ({
    run,
    stop,
    getPlan: vi.fn(),
    deletePlan: vi.fn(),
    metadata: {
      engine: "pi",
      adapter: "pi-agent-core",
      version: "0.85.1",
    },
  }));
  return { createPiAgentRuntime };
});

vi.mock("@openzhiyu/ai/agent", () => ({
  BaseAgent: class {
    protected config: unknown;
    private readonly plans = new Map<string, unknown>();

    constructor(config: unknown) {
      this.config = config;
    }

    protected storePlan(plan: { id: string }) {
      this.plans.set(plan.id, plan);
    }

    getPlan(planId: string) {
      return this.plans.get(planId);
    }

    async stop() {}
  },
  createPiAgentRuntime: mocks.createPiAgentRuntime,
  createPiRuntimeOptionsFromModelConfig: vi.fn(() => ({
    model: { id: "qwen-plus" },
    streamFn: vi.fn(),
  })),
}));

vi.mock("@openzhiyu/ai/agent/plugin", () => ({
  defineAgentPlugin: (plugin: unknown) => plugin,
}));

import { PiAgent } from "@/lib/ai/extensions/agent/pi";

async function collect<T>(generator: AsyncGenerator<T>) {
  const messages: T[] = [];
  for await (const message of generator) {
    messages.push(message);
  }
  return messages;
}

describe("PiAgent runtime tools", () => {
  it("passes host-injected runtimeTools into the Pi runtime without changing defaults", async () => {
    const agent = new PiAgent({
      provider: "pi",
      apiKey: "test-key",
      baseUrl: "https://example.test/v1",
      model: "qwen-plus",
      providerConfig: {
        protocol: "openai-responses",
      },
    });
    const runtimeTool = {
      name: "readFact",
      label: "Read fact",
      description: "Read a deterministic fact",
      parameters: {} as never,
      execute: vi.fn(),
    };

    await collect(
      agent.run("use injected tool", {
        sessionId: "session-with-tools",
        runtimeTools: [runtimeTool],
      }),
    );
    await collect(agent.run("no tools", { sessionId: "session-no-tools" }));

    expect(mocks.createPiAgentRuntime).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        tools: [runtimeTool],
      }),
    );
    expect(mocks.createPiAgentRuntime).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        tools: undefined,
      }),
    );
  });
});
