import { describe, expect, it, vi } from "vitest";
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { createPiAgentRuntime } from "@openzhiyu/ai/agent/runtime";
import {
  createWorkshopReadonlyPiTools,
  WORKSHOP_READONLY_PI_TOOLS,
} from "@/lib/workshops/pi-readonly-tools";
import { buildWorkshopRuntimeToolPolicy } from "@/lib/workshops/tool-classification";
import { executeGuardedRuntimeTool } from "@/lib/ai/runtime/tool-executor";

async function collect(generator: AsyncGenerator<any>) {
  const messages = [];
  for await (const message of generator) messages.push(message);
  return messages;
}

const now = new Date("2026-09-13T00:00:00.000Z");

function fixtures() {
  return {
    sources: [
      {
        id: "source-1",
        type: "manual",
        name: "策略说明",
        uri: null,
        content: "只读来源",
        enabled: true,
        createdAt: now,
      },
    ],
    memories: [
      {
        id: "memory-1",
        kind: "fact",
        content: "湖南白银关注白银价格扰动。",
        confidence: 90,
        tags: ["silver", "watchlist"],
        createdAt: now,
      },
      {
        id: "memory-2",
        kind: "fact",
        content: "AI ETF 需要观察成交量。",
        confidence: 85,
        tags: ["ai", "etf"],
        createdAt: now,
      },
    ],
    directives: [
      {
        id: "directive-1",
        content: "不得创建外发或交易动作。",
        status: "active",
        scope: "current_run",
        priority: 10,
        createdAt: now,
      },
    ],
  };
}

describe("Workshop Pi readonly tools", () => {
  it("executes scoped readonly memory lookup through the guarded Pi tool", async () => {
    const onTrace = vi.fn();
    const tools = createWorkshopReadonlyPiTools({
      ...fixtures(),
      onTrace,
    });
    const memoryTool = tools.find((tool) => tool.name === "workshopReadMemory");

    const result = await memoryTool?.execute("tool-1", {
      query: "silver",
      limit: 5,
    });

    expect(result?.content[0]).toMatchObject({
      type: "text",
    });
    expect(JSON.stringify(result?.details.result)).toContain("memory-1");
    expect(JSON.stringify(result?.details.result)).not.toContain("memory-2");
    expect(onTrace).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "workshopReadMemory",
        status: "completed",
      }),
    );
  });

  it("keeps denied readonly tools from reaching their handler", async () => {
    const onTrace = vi.fn();
    const tools = createWorkshopReadonlyPiTools({
      ...fixtures(),
      policy: {
        allowedTools: [...WORKSHOP_READONLY_PI_TOOLS],
        deniedTools: ["workshopGetDirectives"],
      },
      onTrace,
    });
    const directivesTool = tools.find(
      (tool) => tool.name === "workshopGetDirectives",
    );

    await expect(
      directivesTool?.execute("tool-2", { limit: 5 }),
    ).rejects.toThrow("Tool denied by runtime policy.");

    expect(onTrace).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "workshopGetDirectives",
        status: "denied",
        metadata: expect.objectContaining({
          deniedBeforeHandler: true,
        }),
      }),
    );
  });

  it("accepts workshop risk-classified policies for future mixed tool families", async () => {
    const onTrace = vi.fn();
    const policy = buildWorkshopRuntimeToolPolicy([
      ...WORKSHOP_READONLY_PI_TOOLS,
      "quantPaperPlaceOrder",
      "douyinPublishApprovedDraft",
    ]);
    await expect(
      executeGuardedRuntimeTool({
        toolName: "workshopReadMemory",
        input: {},
        policy,
        handler: () => "ok",
      }),
    ).resolves.toMatchObject({
      ok: true,
    });
    const tools = createWorkshopReadonlyPiTools({
      ...fixtures(),
      policy,
      onTrace,
    });
    const memoryTool = tools.find((tool) => tool.name === "workshopReadMemory");
    const result = await memoryTool?.execute("tool-risk-policy", {
      query: "AI ETF",
      limit: 1,
    });

    expect(JSON.stringify(result?.details.trace.metadata)).toContain("allow");
    expect(result?.details.result).toHaveLength(1);
    expect(onTrace).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "workshopReadMemory",
        status: "completed",
      }),
    );
  });

  it("runs the readonly tool family inside the Pi runtime with a fake provider", async () => {
    const faux = createFauxCore({});
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("workshopReadMemory", { query: "silver", limit: 1 }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("memory read complete"),
    ]);
    const onTrace = vi.fn();
    const runtime = createPiAgentRuntime({
      model: faux.getModel(),
      streamFn: faux.streamSimple,
      tools: createWorkshopReadonlyPiTools({
        ...fixtures(),
        onTrace,
      }),
      toolExecution: "sequential",
    });

    const messages = await collect(
      runtime.run({
        operation: "run",
        prompt: "read memory",
        options: { sessionId: "pi-readonly-session" },
      }),
    );

    expect(messages).toContainEqual({
      type: "tool_use",
      id: expect.any(String),
      name: "workshopReadMemory",
      input: { query: "silver", limit: 1 },
    });
    expect(
      messages.find((message) => message.type === "tool_result")?.output,
    ).toContain("湖南白银");
    expect(messages).toContainEqual({
      type: "result",
      content: "memory read complete",
      cost: 0,
    });
    expect(onTrace).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "workshopReadMemory",
        status: "completed",
      }),
    );
  });
});
