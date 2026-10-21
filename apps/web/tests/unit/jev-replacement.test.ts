import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routeRecallWithJev, type JevRecallSource } from "@/lib/brain/jev-recall-router";
import { prefetchPlatformWithJev } from "@/lib/ai/jev-platform-prefetch";
import { createGuardedPiTool } from "@/lib/ai/runtime/pi-tool-adapter";
import { Type } from "typebox";
import type { PromptEvidenceEmbedding } from "@/lib/ai/runtime/answer-evidence-core";
import { withMemoryDispatchContext, bindMemoryDispatchRuntime } from '@/lib/memory/context/dispatch';
beforeEach(() => vi.stubEnv("PLATFORM_REASONING_MODE", "optimized"));
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
function enabled() { vi.stubEnv("BRAIN_JEV_ROUTING", "replace"); vi.stubEnv("PLATFORM_RECALL_PREFETCH", "jev"); vi.stubEnv("TYPESAFE_API_KEY", "test"); }
const routed = (source: JevRecallSource) => async () => ({ status: "ok" as const, route: source, sources: [source], elapsedMs: 1 });
const providerResult = (values: Partial<Record<JevRecallSource, number>> = {}) => ({ answers: Object.fromEntries(
  (["architecture", "records", "knowledge", "brain"] as JevRecallSource[]).map(source => [source, { type: "noul", noul: values[source] ?? 0.01 }]),
), usage: { input_tokens: 123, output_tokens: 12 } });
async function collect(generator: ReturnType<typeof prefetchPlatformWithJev>) {
  return withMemoryDispatchContext(async () => {
  bindMemoryDispatchRuntime({ engine: 'pi', adapter: 'pi-agent-harness' });
  const events = [];
  while (true) { const next = await generator.next(); if (next.done) return { events, prompt: next.value }; events.push(next.value); }
  });
}
describe("Jev replaces recall decision turns", () => {
  it("binds both exact prompt slices without changing bounded expansion calls", async () => {
    enabled(); vi.stubEnv("BRAIN_JEV_TARGETED_RETRY", "true");
    const execute = vi.fn().mockResolvedValueOnce({ ok: true, data: { architecture: { truncated: true,
      memories: [{ id: "first", content: "原文🙂\n[End tool evidence]" }] } } })
      .mockResolvedValueOnce({ ok: true, data: { architecture: { memories: [{ id: "second", content: "补充🙂" }] } } });
    const tool = createGuardedPiTool({ name: "platformRecall", description: "read", parameters: Type.Object({}), execute });
    const embeddings: PromptEvidenceEmbedding[] = [];
    const result = await collect(prefetchPlatformWithJev({ question: "q", prompt: "用户🙂", tools: [tool],
      onEvidenceEmbedded: async value => { embeddings.push(value); } }, routed("architecture"),
      async () => ({ provider: "typesafe", mode: "active", status: "ok", elapsedMs: 1, coverage: [{ question: "q", support: 0.2 }] })));
    expect(execute).toHaveBeenCalledTimes(2); expect(embeddings).toHaveLength(2);
    const reads = result.events.filter(event => event.type === "tool_result");
    for (const [index, item] of embeddings.entries()) {
      expect(item.prompt).toBe(result.prompt); expect(item.toolCallId).toBe(reads[index].toolUseId);
      expect(item.modelText).toBe(reads[index].output);
      expect(result.prompt.slice(item.offsetUtf16, item.offsetUtf16 + item.modelText.length)).toBe(item.modelText);
    }
  });
  it.each(["denied", "source_failed"])("does not register %s evidence as a prompt delivery", async variant => {
    enabled(); const onEvidenceEmbedded = vi.fn();
    const execute = vi.fn(() => ({ ok: false, error: "source unavailable" }));
    const tool = createGuardedPiTool({ name: "platformRecall", description: "read", parameters: Type.Object({}), execute,
      ...(variant === "denied" ? { policy: { deniedTools: ["platformRecall"] } } : {}) });
    const result = await collect(prefetchPlatformWithJev({ question: "q", prompt: "original", tools: [tool], onEvidenceEmbedded }, routed("records")));
    expect(onEvidenceEmbedded).not.toHaveBeenCalled(); expect(result.events.at(-1)?.isError).toBe(true);
  });
  it("retains the historical evidence boundary when routing falls back", async () => {
    enabled(); const route = vi.fn(async () => ({ status: "degraded" as const, detail: "uncertain_route", elapsedMs: 1 }));
    const execute = vi.fn();
    const tool = createGuardedPiTool({ name: "platformRecall", description: "read", parameters: Type.Object({}), execute });
    const question = "截至快照有多少条记忆？";
    const result = await collect(prefetchPlatformWithJev({ question, prompt: question, tools: [tool] }, route));
    expect(route).toHaveBeenCalledWith(question, undefined, { enabled: true });
    expect(result.prompt).toContain("never relabel live counts as historical counts");
    expect(execute).not.toHaveBeenCalled();
  });
  it("combines only selected sources and retains raw probabilities in the event", async () => {
    enabled();
    const fetchMock = vi.fn(async () => Response.json(providerResult({ architecture: 0.95, records: 0.9 })));
    vi.stubGlobal("fetch", fetchMock);
    const execute = vi.fn(async (_input: unknown) => ({ ok: true, data: {} }));
    const tool = createGuardedPiTool({ name: "platformRecall", description: "read", parameters: Type.Object({}), execute });
    const result = await collect(prefetchPlatformWithJev({ question: "设计和当前状态？", prompt: "main model instructions", tools: [tool] }));
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0]).toMatchObject({ sections: ["registry", "architecture", "works", "loops"] });
    const event = JSON.parse(result.events[0].content!);
    expect(event).toMatchObject({ route: "mixed", sources: ["architecture", "records"], schemaVersion: "recall-sources.v2",
      sourceProbabilities: { architecture: 0.95, records: 0.9, knowledge: 0.01, brain: 0.01 }, usage: { input_tokens: 123 } });
    expect(event.inputHash).toMatch(/^[a-f0-9]{64}$/);
    const payload = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(payload.state).toEqual({ question: "设计和当前状态？" });
    expect(JSON.stringify(payload)).not.toContain("main model instructions");
  });
  it("falls back for any uncertain source while retaining the observed probabilities", async () => {
    enabled(); vi.stubGlobal("fetch", vi.fn(async () => Response.json(providerResult({ architecture: 0.95, records: 0.5 }))));
    const execute = vi.fn();
    const tool = createGuardedPiTool({ name: "platformRecall", description: "read", parameters: Type.Object({}), execute });
    const result = await collect(prefetchPlatformWithJev({ question: "q", prompt: "original", tools: [tool] }));
    expect(execute).not.toHaveBeenCalled(); expect(result.prompt).toBe("original");
    expect(JSON.parse(result.events[0].content!)).toMatchObject({ status: "degraded", detail: "uncertain_route",
      uncertainSources: ["records"], sourceProbabilities: { records: 0.5 } });
  });
  it("can reject all sources and does not copy credentials to the audit", async () => {
    enabled();
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      expect(String(init.body)).not.toContain("apikey_sensitive_value");
      return Response.json(providerResult());
    }));
    const result = await routeRecallWithJev("hello apikey_sensitive_value");
    expect(result).toMatchObject({ status: "ok", route: "none", sources: [] });
    expect(JSON.stringify(result)).not.toContain("apikey_sensitive_value");
  });
  it.each([-0.1, 1.1, "0.9", null])("rejects malformed source probability %s", async value => {
    enabled(); const payload = providerResult();
    payload.answers.records.noul = value as number;
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(payload)));
    expect(await routeRecallWithJev("q")).toMatchObject({ status: "degraded", detail: "invalid_response" });
  });
  it("does not make a request after cancellation", async () => {
    enabled(); const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController(); controller.abort();
    expect(await routeRecallWithJev("q", controller.signal)).toMatchObject({ detail: "aborted" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("expands architecture at most once and preserves initial evidence after failure", async () => {
    enabled(); vi.stubEnv("BRAIN_JEV_TARGETED_RETRY", "true");
    const execute = vi.fn().mockResolvedValueOnce({ ok: true, data: { architecture: { truncated: true, memories: [{ id: "first", content: "initial evidence" }] } } }).mockRejectedValueOnce(Error("offline"));
    const tool = createGuardedPiTool({ name: "platformRecall", description: "read", parameters: Type.Object({}), execute });
    const check = vi.fn(async () => ({ provider: "typesafe" as const, mode: "active" as const, status: "ok" as const, elapsedMs: 1, coverage: [{ question: "q", support: 0.2 }] }));
    const result = await collect(prefetchPlatformWithJev({ question: "q", prompt: "original", tools: [tool] }, routed("architecture"), check));
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1][0]).toMatchObject({ question: "q", sections: ["architecture"], limit: 24 });
    expect(result.prompt).toContain("initial evidence"); expect(result.prompt).toContain("expansion failed");
  });
  it("never supplements a failed source or calls Jev evidence checks for exact records", async () => {
    enabled(); vi.stubEnv("BRAIN_JEV_TARGETED_RETRY", "true");
    const execute = vi.fn(async () => ({ ok: false, data: { architecture: { truncated: true, memories: [] } } }));
    const tool = createGuardedPiTool({ name: "platformRecall", description: "read", parameters: Type.Object({}), execute });
    const check = vi.fn();
    const result = await collect(prefetchPlatformWithJev({ question: "q", prompt: "original", tools: [tool] }, routed("architecture"), check));
    expect(check).not.toHaveBeenCalled(); expect(execute).toHaveBeenCalledTimes(1);
    expect(result.events.at(-1)?.isError).toBe(true);
  });
  it("bounds an unresponsive provider by a two second deadline", async () => {
    enabled(); vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    const pending = routeRecallWithJev("current loop status");
    await vi.advanceTimersByTimeAsync(2000);
    expect(await pending).toMatchObject({ status: "degraded", detail: "timeout", elapsedMs: 2000 });
  });
  it("leaves a general question on the ordinary answer path", async () => {
    enabled(); const execute = vi.fn();
    const tool = createGuardedPiTool({ name: "platformRecall", description: "read", parameters: Type.Object({}), execute });
    const result = await collect(prefetchPlatformWithJev({ question: "hello", prompt: "original", tools: [tool] }, async () => ({ status: "ok", route: "none", elapsedMs: 1 })));
    expect(execute).not.toHaveBeenCalled(); expect(result.prompt).toBe("original");
  });
  it("reads bounded change events when Jev misses a workshop modification question", async () => {
    enabled();
    const question = "自选股猎手车间最近被修改过吗，时间是什么时候，修改了哪些内容";
    const execute = vi.fn(async () => ({ ok: true, data: { changes: { status: "read", events: [{ title: "车间设置已更新" }] } } }));
    const tool = createGuardedPiTool({ name: "platformRecall", description: "read", parameters: Type.Object({}), execute });
    const result = await collect(prefetchPlatformWithJev({ question, prompt: question, tools: [tool] },
      async () => ({ status: "ok", route: "none", sources: [], sourceProbabilities: {
        architecture: 0.1, records: 0.05, knowledge: 0.12, brain: 0.1 }, elapsedMs: 1 })));
    expect(execute).toHaveBeenCalledExactlyOnceWith({ question, sections: ["changes"], limit: 8 }, expect.anything());
    expect(JSON.parse(result.events[0].content!)).toMatchObject({ route: "none", sourceProbabilities: { records: 0.05 },
      applicationRoute: { source: "records", reason: "change_history_requires_event_read" } });
    expect(result.prompt).toContain("车间设置已更新");
  });
  it.each(["brain", "knowledge"] as const)("leaves %s retrieval to its content tools", async source => {
    enabled(); const execute = vi.fn();
    const tool = createGuardedPiTool({ name: "platformRecall", description: "read", parameters: Type.Object({}), execute });
    const result = await collect(prefetchPlatformWithJev({ question: "q", prompt: "original", tools: [tool] }, routed(source)));
    expect(execute).not.toHaveBeenCalled(); expect(result.prompt).toBe("original");
  });
  it("does not override a confident knowledge route for a document change question", async () => {
    enabled(); const execute = vi.fn();
    const tool = createGuardedPiTool({ name: "platformRecall", description: "read", parameters: Type.Object({}), execute });
    const question = "上传的文件最近修改了哪些内容？";
    const result = await collect(prefetchPlatformWithJev({ question, prompt: question, tools: [tool] }, routed("knowledge")));
    expect(execute).not.toHaveBeenCalled();
    expect(JSON.parse(result.events[0].content!)).not.toHaveProperty("applicationRoute");
  });
  it("accepts only confident fixed routes", async () => {
    enabled();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(providerResult({ records: 0.9 }))));
    expect(await routeRecallWithJev("current loop status")).toMatchObject({ status: "ok", route: "records" });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ answers: { route: { type: "choice", choice: "execute_shell", confidence: 0.9 } } })));
    expect(await routeRecallWithJev("current loop status")).toMatchObject({ status: "degraded", detail: "invalid_response" });
  });
  it("does not route or read when the read tool is not authorized", async () => {
    enabled(); const route = vi.fn();
    const result = await collect(prefetchPlatformWithJev({ question: "q", prompt: "original", tools: [] }, route));
    expect(route).not.toHaveBeenCalled(); expect(result.prompt).toBe("original");
  });
  it("calls the existing guarded read once and supplies evidence before generation", async () => {
    enabled(); const execute = vi.fn(async () => ({ ok: true, records: ["real-record"] }));
    const tool = createGuardedPiTool({ name: "platformRecall", description: "read", parameters: Type.Object({}), execute });
    const result = await collect(prefetchPlatformWithJev({ question: "q", prompt: "original", tools: [tool] }, routed("records")));
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.events.map(event => event.type)).toEqual(["reasoning", "tool_use", "tool_result"]);
    expect(result.prompt).toContain("real-record");
    expect(result.prompt).toContain("ALREADY been executed");
    expect(result.prompt).toContain("last persisted phase separately with updatedAt");
    expect(result.prompt).toContain("A permission decision of allow does not establish that an action executed");
  });
  it("cannot override a denied tool even if Jev requests it", async () => {
    enabled(); const execute = vi.fn();
    const tool = createGuardedPiTool({ name: "platformRecall", description: "read", parameters: Type.Object({}), policy: { deniedTools: ["platformRecall"] }, execute });
    const result = await collect(prefetchPlatformWithJev({ question: "q", prompt: "original", tools: [tool] }, routed("records")));
    expect(execute).not.toHaveBeenCalled(); expect(result.prompt).toBe("original");
    expect(result.events.at(-1)?.isError).toBe(true);
  });
  it("falls back without a prefetch for uncertain routing", async () => {
    enabled(); const execute = vi.fn();
    const tool = createGuardedPiTool({ name: "platformRecall", description: "read", parameters: Type.Object({}), execute });
    const result = await collect(prefetchPlatformWithJev({ question: "q", prompt: "original", tools: [tool] }, async () => ({ status: "degraded", detail: "timeout", elapsedMs: 2000 })));
    expect(execute).not.toHaveBeenCalled(); expect(result.prompt).toBe("original");
  });
});
