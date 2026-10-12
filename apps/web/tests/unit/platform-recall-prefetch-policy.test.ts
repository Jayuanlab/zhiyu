import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { createGuardedPiTool } from "@/lib/ai/runtime/pi-tool-adapter";
import { planPlatformRecallPrefetch, prefetchPlatformWithJev } from "@/lib/ai/jev-platform-prefetch";

beforeEach(() => vi.stubEnv("PLATFORM_REASONING_MODE", "optimized"));
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
async function collect(generator: ReturnType<typeof prefetchPlatformWithJev>) {
  const events = [];
  while (true) { const next = await generator.next(); if (next.done) return { events, prompt: next.value }; events.push(next.value); }
}
function tool() {
  const execute = vi.fn(async () => ({ ok: true, data: { changes: { events: [{ id: "real-event" }] } } }));
  return { execute, tool: createGuardedPiTool({ name: "platformRecall", description: "read", parameters: Type.Object({}), execute }) };
}
describe("independent platform recall prefetch", () => {
  it.each(["rules", "jev"])("does not prefetch or check evidence in the agent baseline with old %s flags", async mode => {
    vi.stubEnv("PLATFORM_REASONING_MODE", "agent");
    vi.stubEnv("BRAIN_RECALL_PLANNER", "rules");
    vi.stubEnv("PLATFORM_RECALL_PREFETCH", mode); vi.stubEnv("PLATFORM_CAPABILITY_ROUTING", "jev");
    vi.stubEnv("BRAIN_JEV_ROUTING", "replace"); vi.stubEnv("BRAIN_JEV_MODE", "active");
    vi.stubEnv("BRAIN_JEV_TARGETED_RETRY", "true");
    const read = tool(); const route = vi.fn(); const check = vi.fn(); const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const result = await collect(prefetchPlatformWithJev({ question: "研究车间最近修改了什么？", prompt: "original", tools: [read.tool] }, route, check));
    expect(read.execute).not.toHaveBeenCalled(); expect(route).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    expect(result).toEqual({ events: [], prompt: "original" });
  });
  it("defaults to rules even with legacy replace and capability Jev enabled", async () => {
    vi.stubEnv("PLATFORM_RECALL_PREFETCH", ""); vi.stubEnv("BRAIN_JEV_ROUTING", "replace"); vi.stubEnv("PLATFORM_CAPABILITY_ROUTING", "jev");
    const route = vi.fn(); const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const read = tool();
    const result = await collect(prefetchPlatformWithJev({ question: "研究车间最近修改了什么？", prompt: "original", tools: [read.tool] }, route));
    expect(route).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    expect(read.execute).toHaveBeenCalledExactlyOnceWith({ question: "研究车间最近修改了什么？", sections: ["changes"], limit: 8 }, expect.anything());
    expect(JSON.parse(result.events[0].content!)).toMatchObject({ mode: "rules", provider: "rules" });
    expect(result.prompt).toContain("real-event");
  });
  it.each(["Python 最近更新了什么？", "上传的文件最近修改了哪些内容？", "你好", "最近修改了什么？"])("leaves %s on normal tools", async question => {
    vi.stubEnv("PLATFORM_RECALL_PREFETCH", "rules"); const route = vi.fn(); const read = tool();
    const result = await collect(prefetchPlatformWithJev({ question, prompt: question, tools: [read.tool] }, route));
    expect(read.execute).not.toHaveBeenCalled(); expect(route).not.toHaveBeenCalled();
    expect(result.events).toEqual([]);
  });
  it("resolves a follow-up only from a confirmed target and does not override a document subject", () => {
    const context = { confirmedTarget: { kind: "workshop" as const, id: "actual-workshop" } };
    expect(planPlatformRecallPrefetch("它最近修改了什么？", context).sources).toEqual(["records"]);
    expect(planPlatformRecallPrefetch("上传的文件最近修改了什么？", context).sources).toEqual([]);
  });
  it("binds a pronoun lookup to the actual target without replacing an explicit named subject", async () => {
    vi.stubEnv("PLATFORM_RECALL_PREFETCH", "rules"); const read = tool();
    const context = { confirmedTarget: { kind: "workshop" as const, id: "actual-workshop" } };
    await collect(prefetchPlatformWithJev({ question: "查一下它最近修改了什么？", prompt: "original", tools: [read.tool], context }));
    expect(read.execute).toHaveBeenCalledExactlyOnceWith({ question: "Workshop actual-workshop\n查一下它最近修改了什么？", sections: ["changes"], limit: 8 }, expect.anything());
    read.execute.mockClear();
    await collect(prefetchPlatformWithJev({ question: "另一个车间最近修改了什么？", prompt: "original", tools: [read.tool], context }));
    expect(read.execute).toHaveBeenCalledExactlyOnceWith({ question: "另一个车间最近修改了什么？", sections: ["changes"], limit: 8 }, expect.anything());
  });
  it("off disables only prefetch and preserves the historical evidence boundary", async () => {
    vi.stubEnv("PLATFORM_RECALL_PREFETCH", "off"); const read = tool(); const route = vi.fn();
    const result = await collect(prefetchPlatformWithJev({ question: "截至快照平台状态如何？", prompt: "original", tools: [read.tool] }, route));
    expect(route).not.toHaveBeenCalled(); expect(read.execute).not.toHaveBeenCalled();
    expect(result.prompt).toContain("never relabel live counts as historical counts");
  });
  it("passes minimal context to explicitly enabled Jev, never the full prompt", async () => {
    vi.stubEnv("PLATFORM_RECALL_PREFETCH", "jev"); const read = tool();
    const route = vi.fn(async () => ({ status: "ok" as const, sources: [], route: "none" as const, elapsedMs: 1 }));
    const context = { confirmedTarget: { kind: "workshop" as const, id: "actual" } };
    await collect(prefetchPlatformWithJev({ question: "它的状态", prompt: "private full history", tools: [read.tool], context }, route));
    expect(route).toHaveBeenCalledWith("它的状态", undefined, { enabled: true, context: JSON.stringify(context) });
    expect(JSON.stringify(route.mock.calls)).not.toContain("private full history");
  });
});
