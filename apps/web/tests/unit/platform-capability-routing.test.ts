import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";

const { transport } = vi.hoisted(() => ({ transport: vi.fn() }));
vi.mock("@/lib/memory/retrieval/jev-fetch", () => ({ fetchTypesafe: transport }));
import { buildPlatformCapabilityCatalog } from "@/lib/ai/platform-capabilities";
import { suggestPlatformCapabilities } from "@/lib/ai/platform-capability-routing";

function tool(name: string, description = `Read the current ${name} data`): AgentTool<any> {
  return { name, label: name, description, parameters: Type.Object({ query: Type.String() }), execute: vi.fn() };
}

function catalog(...names: string[]) {
  return buildPlatformCapabilityCatalog({ tools: names.map(name => tool(name)) });
}

function ambiguousCatalog() {
  const current = catalog("searchProjectRecords", "readUserRecords");
  current.capabilities[0].module = "knowledge";
  current.capabilities[1].module = "brain";
  return current;
}

const ambiguousQuestion = "查询平台相关资料";
function semanticResponse(options: {
  choice?: string;
  confidence?: number;
  probabilities?: Record<string, number | undefined>;
  fits?: number[];
} = {}) {
  return {
    answers: {
      selection: { type: "choice", choice: options.choice ?? "candidate_0", confidence: options.confidence ?? 0.95,
        probabilities: options.probabilities ?? { candidate_0: 0.9, candidate_1: 0.05, no_match: 0.05 } },
      fits_0: { type: "noul", noul: options.fits?.[0] ?? 0.92 },
      fits_1: { type: "noul", noul: options.fits?.[1] ?? 0.1 },
    },
    usage: { input_tokens: 120, output_tokens: 15 },
  };
}

beforeEach(() => {
  transport.mockReset().mockImplementation(async () => Response.json(semanticResponse()));
  vi.stubEnv("TYPESAFE_API_KEY", "test-key");
  vi.stubEnv("PLATFORM_CAPABILITY_ROUTING", "rules");
  vi.stubEnv("BRAIN_JEV_ROUTING", "replace");
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("platform capability rule suggestions", () => {
  it("uses independent rules only in an explicit optimization experiment", async () => {
    vi.stubEnv("PLATFORM_REASONING_MODE", "optimized");
    const result = await suggestPlatformCapabilities({ question: ambiguousQuestion, catalog: ambiguousCatalog() });
    expect(result).toMatchObject({ provider: "rules", status: "unresolved", capabilityIds: [], detail: "no_rule_match" });
    expect(result.policyVersion).toBe("platform-capability-routing.v1");
    expect(result.inputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(transport).not.toHaveBeenCalled();
  });

  it("leaves capability planning to the baseline agent despite old Jev flags", async () => {
    vi.stubEnv("PLATFORM_REASONING_MODE", "agent");
    vi.stubEnv("PLATFORM_CAPABILITY_ROUTING", "jev");
    expect(await suggestPlatformCapabilities({ question: ambiguousQuestion, catalog: ambiguousCatalog() }))
      .toMatchObject({ provider: "none", status: "disabled", capabilityIds: [] });
    expect(transport).not.toHaveBeenCalled();
  });

  it.each(["你好", "解释记忆系统原理", "如何实现知识库搜索", "查看杭州天气", "找一首诗", "查询Python含义"])(
    "does not call Jev for general conversation: %s", async question => {
      expect(await suggestPlatformCapabilities({ question, catalog: ambiguousCatalog(), mode: "jev" })).toMatchObject({ provider: "none", status: "ok", capabilityIds: [] });
      expect(transport).not.toHaveBeenCalled();
    });

  it("honors disabled mode before reading or requesting candidates", async () => {
    expect(await suggestPlatformCapabilities({ question: ambiguousQuestion, catalog: ambiguousCatalog(), mode: "off" })).toMatchObject({ provider: "none", status: "disabled", detail: "routing_disabled" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("maps a named current MCP tool to its actual ID and never executes the handler", async () => {
    const installed = tool("mcp__knowledge__searchKnowledgeBase");
    const current = buildPlatformCapabilityCatalog({ tools: [installed] });
    expect(await suggestPlatformCapabilities({ question: "调用 mcp__knowledge__searchKnowledgeBase", catalog: current, mode: "jev" })).toMatchObject({
      provider: "rules", status: "ok", detail: "explicit_capability", capabilityIds: [installed.name],
    });
    expect(installed.execute).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    ["查询知识库里的研究文档", "searchKnowledgeBase"],
    ["读取文档全文", "getFullDocumentContent"],
    ["列出知识库文档", "listKnowledgeBaseDocuments"],
    ["查询微信联系人", "queryContacts"],
    ["查一下我的记忆里提到的偏好", "searchUnifiedMemory"],
    ["查看车间配置", "inspectWorkshopAgent"],
    ["查看最近运行结果", "platformRecall"],
    ["列出持续任务", "listLoopTasks"],
  ])("uses reliable rules for %s without Jev", async (question, expected) => {
    const current = catalog("searchKnowledgeBase", "getFullDocumentContent", "listKnowledgeBaseDocuments", "queryContacts", "searchUnifiedMemory", "inspectWorkshopAgent", "platformRecall", "listLoopTasks");
    expect(await suggestPlatformCapabilities({ question, catalog: current, mode: "jev" })).toMatchObject({ provider: "rules", status: "ok", capabilityIds: [expected] });
    expect(transport).not.toHaveBeenCalled();
  });

  it("combines explicit requests across modules as IDs only", async () => {
    const current = catalog("queryContacts", "searchKnowledgeBase");
    const result = await suggestPlatformCapabilities({ question: "查看微信联系人并查询知识库", catalog: current, mode: "jev" });
    expect(result).toMatchObject({ provider: "rules", status: "ok" });
    expect(result.capabilityIds).toEqual(["searchKnowledgeBase", "queryContacts"]);
    expect(result).not.toHaveProperty("arguments");
    expect(result).not.toHaveProperty("authorization");
    expect(transport).not.toHaveBeenCalled();
  });

  it("resolves a confirmed document reference but never guesses a missing target", async () => {
    const current = catalog("getFullDocumentContent", "searchKnowledgeBase");
    expect(await suggestPlatformCapabilities({ question: "读取它的全文", catalog: current, mode: "jev" })).toMatchObject({ provider: "rules", status: "unresolved", detail: "target_required", capabilityIds: [] });
    expect(await suggestPlatformCapabilities({ question: "读取它的全文", catalog: current, mode: "jev", context: {
      previousUserRequests: ["刚才查看了研究文档"], confirmedTarget: { kind: "document", id: "doc-1", name: "研究" },
    } })).toMatchObject({ provider: "rules", status: "ok", capabilityIds: ["getFullDocumentContent"] });
    expect(transport).not.toHaveBeenCalled();
  });

  it.each(["记忆总体有多少条", "查看记忆各状态的数量", "查询记忆统计分布"])(
    "routes memory statistics only to their complete source: %s", async question => {
      const available = catalog("searchUnifiedMemory", "brainListMemories", "platformRecall");
      expect(await suggestPlatformCapabilities({ question, catalog: available, mode: "jev" })).toMatchObject({ provider: "rules", status: "ok", capabilityIds: ["platformRecall"] });
      const unavailable = catalog("searchUnifiedMemory", "brainListMemories");
      expect(await suggestPlatformCapabilities({ question, catalog: unavailable, mode: "jev" })).toMatchObject({ provider: "rules", status: "unresolved", detail: "capability_unavailable", capabilityIds: [] });
      expect(transport).not.toHaveBeenCalled();
    });

  it("does not substitute Brain snapshots for runtime results", async () => {
    expect(await suggestPlatformCapabilities({ question: "查看最近运行结果", catalog: catalog("brainListSnapshots", "searchProjectRecords"), mode: "jev" })).toMatchObject({
      provider: "rules", status: "unresolved", detail: "capability_unavailable", capabilityIds: [],
    });
    expect(await suggestPlatformCapabilities({ question: "查看最近运行结果", catalog: catalog("observeWorkshop", "brainListSnapshots"), mode: "jev" })).toMatchObject({
      provider: "rules", status: "ok", capabilityIds: ["observeWorkshop"],
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it("never suggests a forbidden tool when allow and deny conflict in the current catalog policy", async () => {
    const forbidden = tool("mcp__knowledge__searchKnowledgeBase");
    const permitted = tool("queryContacts");
    const current = buildPlatformCapabilityCatalog({ tools: [forbidden, permitted], policy: {
      allowedTools: ["searchKnowledgeBase", "queryContacts"], deniedTools: ["searchKnowledgeBase"], defaultDecision: "deny",
    } });
    expect(current.capabilities.map(item => item.id)).toEqual(["queryContacts"]);
    expect(await suggestPlatformCapabilities({ question: "调用 mcp__knowledge__searchKnowledgeBase", catalog: current, mode: "jev" })).toMatchObject({
      provider: "rules", status: "unresolved", capabilityIds: [], detail: "capability_unavailable",
    });
    expect(forbidden.execute).not.toHaveBeenCalled();
    expect(permitted.execute).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });
});

describe("bounded Jev semantic capability suggestions", () => {
  it("calls once only for an ambiguous platform request and projects redacted metadata without parameter defaults", async () => {
    const current = ambiguousCatalog();
    current.capabilities[0].parameters = { type: "object", properties: { token: { default: "parameter-secret" } } };
    current.capabilities[0].description = "Read records; password=description-secret";
    const result = await suggestPlatformCapabilities({ question: "查询平台相关资料 password=question-secret", catalog: current, mode: "jev", context: {
      previousUserRequests: ["用户此前请求 password=context-secret"], confirmedTarget: { kind: "workshop", id: "work-1", name: "分析" },
    } });
    expect(result).toMatchObject({ provider: "jev", status: "ok", capabilityIds: ["searchProjectRecords"], model: "jev-1.13.0", detail: "semantic_match", usage: { input_tokens: 120, output_tokens: 15 } });
    expect(transport).toHaveBeenCalledOnce();
    const request = JSON.parse(transport.mock.calls[0][1].body);
    expect(request.model).toBe("jev-1.13.0");
    expect(request.state.candidates.map((item: any) => item.module)).toEqual(["knowledge", "brain"]);
    expect(request.questions.selection).toMatchObject({ type: "choice", criteria: { candidate_0: expect.any(String), candidate_1: expect.any(String), no_match: expect.any(String) } });
    expect(Object.keys(request.questions)).toEqual(["selection", "fits_0", "fits_1"]);
    expect(request.questions.fits_0.type).toBe("noul");
    expect(request.state.context.confirmedTarget.id).toBe("work-1");
    const body = transport.mock.calls[0][1].body;
    expect(body).not.toContain("parameter-secret");
    expect(body).not.toContain("question-secret");
    expect(body).not.toContain("context-secret");
    expect(body).not.toContain("description-secret");
    expect(body).not.toContain("parameters");
    expect(result.inputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("accepts one previous request longer than 800 characters when the entire context is within 2000", async () => {
    const context = { previousUserRequests: ["x".repeat(1900)] };
    expect(JSON.stringify(context).length).toBeLessThan(2000);
    expect(await suggestPlatformCapabilities({ question: ambiguousQuestion, catalog: ambiguousCatalog(), mode: "jev", context })).toMatchObject({ provider: "jev", status: "ok" });
    expect(transport).toHaveBeenCalledOnce();
  });

  it.each([
    { previousUserRequests: ["x".repeat(2001)] },
    { previousUserRequests: ["x".repeat(1100), "y".repeat(1100)] },
    { previousUserRequests: ["first", "second", "third"] },
  ])("rejects the complete over-budget context explicitly", async context => {
    expect(await suggestPlatformCapabilities({ question: ambiguousQuestion, catalog: ambiguousCatalog(), mode: "jev", context })).toMatchObject({ provider: "none", status: "degraded", detail: "context_limit" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("keeps no_match unresolved without inventing a catalog ID", async () => {
    transport.mockResolvedValueOnce(Response.json(semanticResponse({ choice: "no_match", probabilities: { candidate_0: 0.05, candidate_1: 0.05, no_match: 0.9 } })));
    expect(await suggestPlatformCapabilities({ question: ambiguousQuestion, catalog: ambiguousCatalog(), mode: "jev" })).toMatchObject({ provider: "jev", status: "unresolved", detail: "no_match", capabilityIds: [] });
  });

  it.each([
    { confidence: 0.79 },
    { probabilities: { candidate_0: 0.79, candidate_1: 0.11, no_match: 0.1 } },
    { fits: [0.79, 0.99] },
  ])("requires confidence, the selected probability and its own fit independently", async options => {
    transport.mockResolvedValueOnce(Response.json(semanticResponse(options)));
    expect(await suggestPlatformCapabilities({ question: ambiguousQuestion, catalog: ambiguousCatalog(), mode: "jev" })).toMatchObject({ provider: "jev", status: "unresolved", detail: "uncertain_match", capabilityIds: [] });
  });

  it("rejects a forged choice that does not have the highest probability", async () => {
    transport.mockResolvedValueOnce(Response.json(semanticResponse({ probabilities: { candidate_0: 0.1, candidate_1: 0.85, no_match: 0.05 }, confidence: 0.99, fits: [0.99, 0.99] })));
    expect(await suggestPlatformCapabilities({ question: ambiguousQuestion, catalog: ambiguousCatalog(), mode: "jev" })).toMatchObject({ provider: "jev", status: "degraded", detail: "invalid_response", capabilityIds: [] });
  });

  it.each([
    { choice: "forbiddenTool" },
    { choice: "searchProjectRecords" },
    { probabilities: { candidate_0: 0.9, candidate_1: 0.1 } },
    { probabilities: { candidate_0: 0.9, candidate_1: 0.05, no_match: 0.05, extra: 0 } },
    { probabilities: { candidate_0: 0.9, candidate_1: 0.01, no_match: 0.01 } },
    { probabilities: { candidate_0: 1.01, candidate_1: -0.02, no_match: 0.01 } },
    { fits: [Number.NaN, 0.99] },
  ])("rejects an unknown winner or invalid response distribution", async options => {
    transport.mockResolvedValueOnce(Response.json(semanticResponse(options)));
    expect(await suggestPlatformCapabilities({ question: ambiguousQuestion, catalog: ambiguousCatalog(), mode: "jev" })).toMatchObject({ provider: "jev", status: "degraded", detail: "invalid_response", capabilityIds: [] });
  });

  it("uses an injected transport and returns only the selected actual ID even for duplicate labels", async () => {
    const current = ambiguousCatalog();
    current.capabilities[0].label = current.capabilities[1].label = "records";
    const fetch = vi.fn(async () => Response.json(semanticResponse({ choice: "candidate_1", probabilities: { candidate_0: 0.04, candidate_1: 0.91, no_match: 0.05 }, fits: [0.1, 0.95] })));
    expect(await suggestPlatformCapabilities({ question: ambiguousQuestion, catalog: current, mode: "jev" }, { fetch })).toMatchObject({ provider: "jev", status: "ok", capabilityIds: ["readUserRecords"] });
    expect(fetch).toHaveBeenCalledOnce();
    expect(transport).not.toHaveBeenCalled();
  });

  it("bounds candidate count and UTF-8 request bytes before any external call", async () => {
    const many = catalog(...Array.from({ length: 49 }, (_, i) => `searchRecords${i}`));
    expect(await suggestPlatformCapabilities({ question: ambiguousQuestion, catalog: many, mode: "jev" })).toMatchObject({ provider: "jev", status: "degraded", detail: "candidate_limit" });
    const large = ambiguousCatalog();
    large.capabilities.forEach(item => { item.description = "资料".repeat(4000); });
    expect(await suggestPlatformCapabilities({ question: ambiguousQuestion, catalog: large, mode: "jev" })).toMatchObject({ provider: "jev", status: "degraded", detail: "request_limit" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("returns an explicit missing-key degradation", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "");
    expect(await suggestPlatformCapabilities({ question: ambiguousQuestion, catalog: ambiguousCatalog(), mode: "jev" })).toMatchObject({ provider: "jev", status: "degraded", detail: "missing_api_key" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("cancels failed HTTP bodies while preserving the safe status code", async () => {
    const cancel = vi.fn(async () => { throw Error("private cleanup detail"); });
    transport.mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { status: 429 }));
    expect(await suggestPlatformCapabilities({ question: ambiguousQuestion, catalog: ambiguousCatalog(), mode: "jev" })).toMatchObject({ provider: "jev", status: "degraded", detail: "http_429" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("bounds response bytes and releases the cancelled reader", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(100_001)); }, cancel }));
    transport.mockResolvedValueOnce(response);
    expect(await suggestPlatformCapabilities({ question: ambiguousQuestion, catalog: ambiguousCatalog(), mode: "jev" })).toMatchObject({ provider: "jev", status: "degraded", detail: "response_too_large" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
  });

  it("bounds body parsing and cancels a response that never completes", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    transport.mockResolvedValueOnce(new Response(new ReadableStream({ cancel })));
    const pending = suggestPlatformCapabilities({ question: ambiguousQuestion, catalog: ambiguousCatalog(), mode: "jev" }, { timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toMatchObject({ provider: "jev", status: "degraded", detail: "timeout", elapsedMs: 100 });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("caps the deadline at two seconds even when transport ignores abort", async () => {
    vi.useFakeTimers();
    transport.mockImplementationOnce(() => new Promise<Response>(() => {}));
    const pending = suggestPlatformCapabilities({ question: ambiguousQuestion, catalog: ambiguousCatalog(), mode: "jev" }, { timeoutMs: 60_000 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(await pending).toMatchObject({ provider: "jev", status: "degraded", detail: "timeout", elapsedMs: 2000 });
    expect(transport.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it("handles external cancellation even when transport ignores it", async () => {
    transport.mockImplementationOnce(() => new Promise<Response>(() => {}));
    const controller = new AbortController();
    const pending = suggestPlatformCapabilities({ question: ambiguousQuestion, catalog: ambiguousCatalog(), mode: "jev", signal: controller.signal });
    controller.abort();
    expect(await pending).toMatchObject({ provider: "jev", status: "degraded", detail: "aborted" });
    expect(transport.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it("cancels an in-flight response body on external cancellation", async () => {
    const cancel = vi.fn();
    transport.mockResolvedValueOnce(new Response(new ReadableStream({ cancel })));
    const controller = new AbortController();
    const pending = suggestPlatformCapabilities({ question: ambiguousQuestion, catalog: ambiguousCatalog(), mode: "jev", signal: controller.signal });
    await vi.waitFor(() => expect(transport).toHaveBeenCalledOnce());
    await Promise.resolve();
    controller.abort();
    expect(await pending).toMatchObject({ provider: "jev", status: "degraded", detail: "aborted" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each(["typesafe_proxy_invalid_url", "typesafe_proxy_unsupported_protocol", "typesafe_proxy_initialization_error", "typesafe_proxy_transport_error"])(
    "preserves safe proxy diagnostic %s", async detail => {
      transport.mockRejectedValueOnce(Error(detail));
      expect(await suggestPlatformCapabilities({ question: ambiguousQuestion, catalog: ambiguousCatalog(), mode: "jev" })).toMatchObject({ provider: "jev", status: "degraded", detail });
    });

  it("does not expose credentials or provider text in a failure", async () => {
    transport.mockRejectedValueOnce(Error("http://user:private-password@proxy.invalid failed"));
    const result = await suggestPlatformCapabilities({ question: ambiguousQuestion, catalog: ambiguousCatalog(), mode: "jev" });
    expect(result.detail).toBe("transport_error");
    expect(JSON.stringify(result)).not.toContain("private-password");
  });

  it("fails closed for duplicate IDs rather than accepting an ambiguous mapping", async () => {
    const current = ambiguousCatalog();
    current.capabilities[1].id = current.capabilities[0].id;
    expect(await suggestPlatformCapabilities({ question: ambiguousQuestion, catalog: current, mode: "jev" })).toMatchObject({ provider: "none", status: "degraded", detail: "invalid_catalog", capabilityIds: [] });
    expect(transport).not.toHaveBeenCalled();
  });
});
