import { describe, expect, it } from "vitest";
import { PiAgent, piPlugin } from "@/lib/ai/extensions/agent/pi";

async function collect<T>(generator: AsyncGenerator<T>) {
  const messages: T[] = [];
  for await (const message of generator) {
    messages.push(message);
  }
  return messages;
}

function createAgent() {
  return new PiAgent({
    provider: "pi",
    apiKey: "test-key",
    baseUrl: "https://example.test/v1",
    model: "qwen-plus",
    providerConfig: {
      protocol: "openai-responses",
    },
  });
}

describe("PiAgent provider", () => {
  it("creates and stores a text-only execution plan", async () => {
    const agent = createAgent();

    const messages = await collect(agent.plan("Explain Pi migration status"));
    const planMessage = messages.find((message) => message.type === "plan");

    expect(planMessage?.plan).toMatchObject({
      goal: "Explain Pi migration status",
    });
    expect(planMessage?.plan?.notes).toContain("platformRecall");
    expect(planMessage?.plan?.notes).toContain("read-only");
    expect(planMessage?.plan?.steps).toHaveLength(2);
    expect(agent.getPlan(planMessage?.plan?.id ?? "")).toEqual(
      planMessage?.plan,
    );
    expect(messages.at(-1)).toEqual({ type: "done" });
  });

  it("returns a visible error when executing without a stored plan", async () => {
    const agent = createAgent();

    await expect(
      collect(
        agent.execute({
          planId: "missing-plan",
          originalPrompt: "Explain Pi migration status",
        }),
      ),
    ).resolves.toEqual([
      {
        type: "error",
        message: "Plan not found or expired. Please re-plan before executing.",
      },
      { type: "done" },
    ]);
  });

  it("advertises platformRecall as a read-only Pi capability", () => {
    expect(piPlugin.metadata.description).toContain("platformRecall");
    const capabilities = piPlugin.metadata.capabilities as {
      readOnlyTools?: Record<string, boolean>;
    };
    expect(capabilities.readOnlyTools?.platformRecall).toBe(true);
  });
});
