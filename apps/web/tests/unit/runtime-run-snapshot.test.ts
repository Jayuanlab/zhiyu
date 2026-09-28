import { describe, expect, it } from "vitest";
import {
  buildAgentRuntimeRunSnapshot,
  parseAgentRuntimeRunSnapshot,
  sha256Hex,
  stableJson,
} from "@/lib/ai/runtime/run-snapshot";

const baseInput = {
  runtime: {
    engine: "pi" as const,
    adapter: "pi-agent-core",
    version: "0.85.1",
  },
  runtimeSelection: {
    engine: "pi" as const,
    source: "config" as const,
    piProtocol: "openai-responses" as const,
  },
  model: {
    model: "fixture-model",
    tier: "standard",
    source: "user" as const,
  },
  prompt: "read current workshop memory",
  allowedTools: ["workshopReadMemory", "workshopListSources"],
  policy: {
    denied: ["externalPayment"],
    approval: { externalWrites: "require_approval" },
  },
};

describe("agent runtime run snapshot", () => {
  it("serializes object keys stably before hashing", () => {
    expect(stableJson({ b: 2, a: { d: 4, c: 3 } })).toBe(
      '{"a":{"c":3,"d":4},"b":2}',
    );
    expect(sha256Hex({ a: 1, b: 2 })).toBe(sha256Hex({ b: 2, a: 1 }));
  });

  it("redacts secret-like fields before serializing or hashing", () => {
    expect(stableJson({ model: "fixture", apiKey: "secret-1" })).toBe(
      '{"apiKey":"[redacted]","model":"fixture"}',
    );
    expect(
      sha256Hex({
        model: "fixture",
        credentials: {
          authorization: "Bearer secret-1",
          token: "secret-2",
        },
      }),
    ).toBe(
      sha256Hex({
        model: "fixture",
        credentials: {
          authorization: "Bearer changed",
          token: "changed",
        },
      }),
    );
  });

  it("normalizes allowlist order and records runtime identity", () => {
    const left = buildAgentRuntimeRunSnapshot(baseInput);
    const right = buildAgentRuntimeRunSnapshot({
      ...baseInput,
      allowedTools: ["workshopListSources", "workshopReadMemory"],
    });

    expect(left).toMatchObject({
      schemaVersion: "agent-runtime-run-snapshot.v1",
      engine: "pi",
      adapter: "pi-agent-core",
      adapterVersion: "0.85.1",
      selectionSource: "config",
      piProtocol: "openai-responses",
      model: "fixture-model",
      modelTier: "standard",
      modelSource: "user",
      allowedToolCount: 2,
    });
    expect(left.allowedToolsHash).toBe(right.allowedToolsHash);
    expect(left.runtimeHash).toBe(right.runtimeHash);
  });

  it("changes hashes when prompt or policy changes without storing secrets", () => {
    const base = buildAgentRuntimeRunSnapshot({
      ...baseInput,
      extra: { apiKey: "should-not-be-here" },
    });
    const secretChanged = buildAgentRuntimeRunSnapshot({
      ...baseInput,
      extra: { apiKey: "rotated-secret" },
    });
    const promptChanged = buildAgentRuntimeRunSnapshot({
      ...baseInput,
      prompt: "different prompt",
    });
    const policyChanged = buildAgentRuntimeRunSnapshot({
      ...baseInput,
      policy: {
        denied: ["realBrokerOrder"],
      },
    });

    expect(promptChanged.promptHash).not.toBe(base.promptHash);
    expect(policyChanged.policyHash).not.toBe(base.policyHash);
    expect(secretChanged.runtimeHash).toBe(base.runtimeHash);
    expect(JSON.stringify(base)).not.toContain("should-not-be-here");
  });

  it("stores redacted extra runtime audit metadata for Pi tool summaries", () => {
    const snapshot = buildAgentRuntimeRunSnapshot({
      ...baseInput,
      extra: {
        apiKey: "should-not-be-stored",
        piTools: {
          readonly: ["workshopReadMemory"],
          reviewableProposal: [
            "workshopProposeAgentChange",
            "quantPaperProposeWatchlistChange",
          ],
          internalWrite: ["workshopLogEvent", "workshopWriteMemory"],
        },
      },
    });

    expect(snapshot.extra).toMatchObject({
      apiKey: "[redacted]",
      piTools: {
        readonly: ["workshopReadMemory"],
        reviewableProposal: [
          "workshopProposeAgentChange",
          "quantPaperProposeWatchlistChange",
        ],
        internalWrite: ["workshopLogEvent", "workshopWriteMemory"],
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain("should-not-be-stored");
  });

  it("tracks system instructions separately while keeping the task prompt hash stable", () => {
    const initial = buildAgentRuntimeRunSnapshot({
      ...baseInput,
      systemPrompt: "Observe within the workshop mission.",
    });
    const revised = buildAgentRuntimeRunSnapshot({
      ...baseInput,
      systemPrompt: "Observe within the workshop mission and cite evidence.",
    });

    expect(initial.systemPromptHash).toMatch(/^[a-f0-9]{64}$/);
    expect(revised.systemPromptHash).not.toBe(initial.systemPromptHash);
    expect(revised.runtimeHash).not.toBe(initial.runtimeHash);
    expect(revised.promptHash).toBe(initial.promptHash);
    expect(revised.policyHash).toBe(initial.policyHash);
    expect(revised.allowedToolsHash).toBe(initial.allowedToolsHash);
    expect(parseAgentRuntimeRunSnapshot(JSON.parse(JSON.stringify(initial)))).toEqual(initial);
  });

  it("accepts legacy v1 records without inventing a system prompt hash", () => {
    const legacy = buildAgentRuntimeRunSnapshot(baseInput);
    const parsed = parseAgentRuntimeRunSnapshot(JSON.parse(JSON.stringify(legacy)));

    expect(legacy).not.toHaveProperty("systemPromptHash");
    expect(parsed).toEqual(legacy);
    expect(parsed).not.toHaveProperty("systemPromptHash");

    const explicitEmpty = buildAgentRuntimeRunSnapshot({ ...baseInput, systemPrompt: "" });
    expect(explicitEmpty.systemPromptHash).toBe(sha256Hex(""));
    expect(explicitEmpty.runtimeHash).not.toBe(legacy.runtimeHash);
  });

  it("does not persist either raw prompt or credentials with a system prompt hash", () => {
    const snapshot = buildAgentRuntimeRunSnapshot({
      ...baseInput,
      prompt: "private-task-marker",
      systemPrompt: "private-system-marker",
      extra: { credentials: { token: "private-credential-marker" } },
    });
    const serialized = JSON.stringify(snapshot);

    expect(serialized).not.toContain("private-task-marker");
    expect(serialized).not.toContain("private-system-marker");
    expect(serialized).not.toContain("private-credential-marker");
    expect(snapshot.extra).toEqual({ credentials: "[redacted]" });
  });

  it.each([null, "", 123])("rejects an invalid supplied system prompt hash: %s", (systemPromptHash) => {
    expect(parseAgentRuntimeRunSnapshot({
      ...buildAgentRuntimeRunSnapshot(baseInput),
      systemPromptHash,
    })).toBeNull();
  });
});
