import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "@openzhiyu/ai/agent/types";
import { createPiAgentRuntime } from "@openzhiyu/ai/agent/runtime";
import type { AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { FinalizeContextPackInput } from "@/lib/memory/context/finalize";
import type { BrainContextPack } from "@/lib/memory/context/pack";

const fixture = vi.hoisted(() => ({
  finalize: vi.fn<(input: FinalizeContextPackInput) => Promise<BrainContextPack>>(),
  commits: 0, rollbacks: 0,
}));
vi.mock("@/lib/memory/context/finalize", () => ({ finalizeContextPack: fixture.finalize }));
vi.mock("@/lib/db/client", () => ({ withDatabaseTransaction: async <T>(work: () => Promise<T>): Promise<T> => {
  try { const result = await work(); fixture.commits++; return result; }
  catch (error) { fixture.rollbacks++; throw error; }
} }));
import { assertMemoryDispatchCurrent, bindMemoryDispatchRuntime, registerContextForDispatch, withMemoryDispatchContext as scopeMemoryDispatch } from "@/lib/memory/context/dispatch";
import { memoryRecallPlanForTrace } from "@/lib/memory/context/dispatch-trace";

const id = "11111111-1111-4111-8111-111111111111";
const withMemoryDispatchContext = <T>(work: () => Promise<T>): Promise<T> => scopeMemoryDispatch(() => {
  bindMemoryDispatchRuntime({ engine: "pi", adapter: "pi-agent-harness" });
  return work();
});
function input(version = "bmrv1:original", memoryId = id): FinalizeContextPackInput {
  return { requester: { type: "work", userId: "22222222-2222-4222-8222-222222222222", workId: "work-a", id: "work-a" },
    taskIntent: "Answer using the current project", sourceFilters: { scenarioKeys: ["project:alpha"] },
    pack: { interfaceVersion: "brain-context.v1", contextLogId: "recall-receipt", items: [{ id: memoryId,
      revisionVersion: version, ownerType: "work", ownerId: "work-a", memoryType: "fact", subject: "source",
      content: "original selected memory body", evidenceRefs: ["source:original"], score: 1, reasons: [] }],
      denied: [], omitted: [], selection: { selectedCount: 1, deniedCount: 0, omittedCount: 0,
        duplicateCanonicalGroupCount: 0, selectedCanonicalKinds: {} } } };
}
async function collect(generator: AsyncGenerator<AgentMessage>) {
  const messages: AgentMessage[] = [];
  for await (const message of generator) messages.push(message);
  return messages;
}
function runtimeFixture(tools: AgentTool[] = [], adapter: "harness" | "agent" = "harness") {
  const faux = createFauxCore({});
  const stream = vi.fn<StreamFn>(async (...args) => faux.streamSimple(...args));
  const runtime = createPiAgentRuntime({ adapter, model: faux.getModel(), streamFn: stream, tools });
  faux.setResponses([fauxAssistantMessage("completed")]);
  return { faux, stream, runtime };
}
beforeEach(() => {
  vi.clearAllMocks(); fixture.commits = fixture.rollbacks = 0;
  fixture.finalize.mockImplementation(async value => ({ ...value.pack, contextLogId: "dispatch-receipt" }));
});

describe("run-local memory provider admission", () => {
  it("does not admit a run whose actual runtime has never been bound", async () => {
    await scopeMemoryDispatch(async () => {
      registerContextForDispatch(input());
      await expect(assertMemoryDispatchCurrent()).rejects.toMatchObject({ code: "memory_dispatch_context_unavailable" });
    });
    expect(fixture.finalize).not.toHaveBeenCalled();
  });

  it("is opt-in by host run and snapshots caller-owned values", async () => {
    registerContextForDispatch(input());
    await expect(assertMemoryDispatchCurrent()).rejects.toMatchObject({ code: "memory_dispatch_context_unavailable" });
    expect(fixture.finalize).not.toHaveBeenCalled();
    await withMemoryDispatchContext(async () => {
      const selected = input();
      selected.now = new Date("2001-01-01");
      selected.metadata = { provider: { apiKey: "never-log-this" } };
      registerContextForDispatch(selected);
      selected.pack.items[0]!.content = "mutated by caller";
      await withMemoryDispatchContext(assertMemoryDispatchCurrent);
      const checked = fixture.finalize.mock.calls[0]![0];
      expect(checked.pack.items[0]!.content).toBe("");
      expect(checked.pack.items[0]!.revisionVersion).toBe("bmrv1:original");
      expect(JSON.stringify(checked)).not.toContain("original selected memory body");
      expect(checked.now).toBeUndefined();
      expect(JSON.stringify(checked)).not.toContain("never-log-this");
      expect(checked.metadata).toMatchObject({ source: "memory_provider_dispatch_admission", dispatch: { sequence: 1 } });
    });
    expect(fixture.commits).toBe(1);
  });

  it("deduplicates repeated refs but retains their exact authorization and scope", async () => {
    await withMemoryDispatchContext(async () => {
      for (let index = 0; index < 300; index++) registerContextForDispatch(input());
      const other = input(); other.sourceFilters = { scenarioKeys: ["project:beta"] }; other.accessMode = "strict";
      registerContextForDispatch(other);
      await assertMemoryDispatchCurrent();
      expect(fixture.finalize).toHaveBeenCalledTimes(2);
      expect(fixture.finalize.mock.calls.map(([value]) => value.pack.items.length)).toEqual([1, 1]);
      expect(fixture.finalize.mock.calls[0]![0].sourceFilters).toEqual({ scenarioKeys: ["project:alpha"] });
      expect(fixture.finalize.mock.calls[1]![0]).toMatchObject({ sourceFilters: { scenarioKeys: ["project:beta"] }, accessMode: "strict" });
    });
    expect(fixture.commits).toBe(1);
  });

  it("never upgrades an old transcript version by registering a newer recall", async () => {
    await withMemoryDispatchContext(async () => {
      registerContextForDispatch(input("bmrv1:old"));
      expect(() => registerContextForDispatch(input("bmrv1:new"))).toThrow("start a fresh context");
      await expect(assertMemoryDispatchCurrent()).rejects.toMatchObject({ code: "memory_dispatch_context_unavailable" });
    });
    expect(fixture.finalize).not.toHaveBeenCalled();
  });

  it("fails closed for a runtime without the provider hook, including subsequent tool recall", async () => {
    await withMemoryDispatchContext(async () => {
      registerContextForDispatch(input());
      expect(() => bindMemoryDispatchRuntime({ engine: "claude", adapter: "claude-agent-sdk" })).toThrow("start a fresh context");
    });
    await withMemoryDispatchContext(async () => {
      bindMemoryDispatchRuntime({ engine: "claude", adapter: "claude-agent-sdk" });
      bindMemoryDispatchRuntime({ engine: "pi", adapter: "pi-agent-harness" });
      expect(() => registerContextForDispatch(input())).toThrow("start a fresh context");
    });
    expect(fixture.finalize).not.toHaveBeenCalled();
  });

  it.each(["denied", "expired", "deleted", "changed"])("blocks %s sources and rolls back the admission batch", async reason => {
    fixture.finalize.mockImplementation(async value => ({ ...value.pack, contextLogId: "not-committed",
      items: reason === "changed" ? value.pack.items.map(item => ({ ...item, revisionVersion: "bmrv1:new" })) : [] }));
    await withMemoryDispatchContext(async () => {
      registerContextForDispatch(input());
      await expect(assertMemoryDispatchCurrent()).rejects.toMatchObject({ code: "memory_dispatch_context_unavailable" });
    });
    expect(fixture.commits).toBe(0); expect(fixture.rollbacks).toBe(1);
  });

  it("does not admit a changed registry while the audit is pending", async () => {
    let release!: (pack: BrainContextPack) => void;
    fixture.finalize.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    await withMemoryDispatchContext(async () => {
      registerContextForDispatch(input());
      const pending = assertMemoryDispatchCurrent();
      registerContextForDispatch(input("bmrv1:another", "33333333-3333-4333-8333-333333333333"));
      release({ ...input().pack, contextLogId: "not-committed" });
      await expect(pending).rejects.toMatchObject({ code: "memory_dispatch_context_unavailable" });
    });
    expect(fixture.commits).toBe(0);
  });

  it("bounds unique proofs without silently evicting transcript evidence", async () => {
    await withMemoryDispatchContext(async () => {
      for (let index = 0; index < 256; index++) registerContextForDispatch(input("bmrv1:v", String(index)));
      expect(() => registerContextForDispatch(input("bmrv1:v", "overflow"))).toThrow("start a fresh context");
      await expect(assertMemoryDispatchCurrent()).rejects.toThrow("start a fresh context");
    });
  });

  it("rejects detached work after the host scope has closed", async () => {
    let resume!: () => void;
    let detached!: Promise<void>;
    await withMemoryDispatchContext(async () => {
      const gate = new Promise<void>(resolve => { resume = resolve; });
      detached = gate.then(assertMemoryDispatchCurrent);
    });
    resume();
    await expect(detached).rejects.toThrow("start a fresh context");
  });
});

describe("actual Pi Harness outbound hook", () => {
  it.each(["audit", "source"])("makes zero provider calls when %s admission fails", async failure => {
    if (failure === "audit") fixture.finalize.mockRejectedValueOnce(new Error("receipt commit failed"));
    else fixture.finalize.mockImplementationOnce(async value => ({ ...value.pack, contextLogId: "receipt", items: [] }));
    const { runtime, stream } = runtimeFixture();
    const messages = await withMemoryDispatchContext(async () => {
      registerContextForDispatch(input());
      return collect(runtime.run({ operation: "run", prompt: input().pack.items[0]!.content,
        options: { onBeforeProviderRequest: assertMemoryDispatchCurrent } }));
    });
    expect(stream).not.toHaveBeenCalled();
    expect(messages.find(message => message.type === "runtime_terminal")?.runtimeTerminal).toMatchObject({ status: "failed" });
    expect(messages.some(message => message.type === "result")).toBe(false);
  });

  it("awaits the durable admission before calling the provider", async () => {
    let release!: (pack: BrainContextPack) => void;
    const began = new Promise<void>(resolve => {
      fixture.finalize.mockImplementationOnce(() => { resolve(); return new Promise(done => { release = done; }); });
    });
    const { runtime, stream } = runtimeFixture();
    const pending = withMemoryDispatchContext(async () => {
      registerContextForDispatch(input());
      return collect(runtime.run({ operation: "run", prompt: "answer", options: { onBeforeProviderRequest: assertMemoryDispatchCurrent } }));
    });
    await began;
    expect(stream).not.toHaveBeenCalled();
    release({ ...input().pack, contextLogId: "committed" });
    const messages = await pending;
    expect(stream).toHaveBeenCalledOnce();
    expect(fixture.commits).toBe(1);
    expect(messages.find(message => message.type === "runtime_terminal")?.runtimeTerminal?.status).toBe("completed");
  });

  it("also fences memory returned by a tool before the next logical request", async () => {
    const execute = vi.fn(async () => {
      registerContextForDispatch(input());
      // The source is revoked after the tool read, before the next provider call.
      fixture.finalize.mockImplementationOnce(async value => ({ ...value.pack, contextLogId: "withheld", items: [] }));
      return { content: [{ type: "text" as const, text: input().pack.items[0]!.content }], details: {} };
    });
    const { runtime, stream, faux } = runtimeFixture([{ name: "recall", label: "recall", description: "recall",
      parameters: Type.Object({}), replay: "safe", execute }]);
    faux.setResponses([fauxAssistantMessage(fauxToolCall("recall", {}), { stopReason: "toolUse" }), fauxAssistantMessage("must not be requested")]);
    const messages = await withMemoryDispatchContext(() => collect(runtime.run({ operation: "run", prompt: "recall",
      options: { onBeforeProviderRequest: assertMemoryDispatchCurrent } })));
    expect(execute).toHaveBeenCalledOnce(); expect(stream).toHaveBeenCalledOnce();
    expect(messages.find(message => message.type === "runtime_terminal")?.runtimeTerminal?.status).toBe("failed");
  });

  it("also invokes host admission in the explicitly selected Pi rollback adapter", async () => {
    const { runtime, stream } = runtimeFixture([], "agent");
    fixture.finalize.mockRejectedValueOnce(new Error("audit unavailable"));
    const messages = await withMemoryDispatchContext(async () => {
      registerContextForDispatch(input()); bindMemoryDispatchRuntime(runtime.metadata);
      return collect(runtime.run({ operation: "run", prompt: "old body", options: { onBeforeProviderRequest: assertMemoryDispatchCurrent } }));
    });
    expect(stream).not.toHaveBeenCalled();
    expect(messages.some(message => message.type === "error")).toBe(true);
    expect(messages.some(message => message.type === "result")).toBe(false);
  });
});

it("projects provider-safe trace fields even when runtime objects carry secrets", () => {
  const provider = { source: "user_openai_compatible" as const, model: "test", protocol: "openai-completions" as const,
    migrated: false, apiKey: "private-key", baseUrl: "https://private-endpoint.invalid" };
  const plan = { interfaceVersion: "brain-recall-plan.v1" as const, mode: "rules" as const,
    statuses: [], searchTerms: [], includeCandidates: false, maxItems: 1, memoryLimit: 1, routes: [], rationale: [], warnings: [], provider };
  const safe = memoryRecallPlanForTrace(plan);
  expect(safe.provider).toMatchObject({ source: "user_openai_compatible", model: "test" });
  expect(JSON.stringify(safe)).not.toContain("private-key");
  expect(JSON.stringify(safe)).not.toContain("private-endpoint");
});
