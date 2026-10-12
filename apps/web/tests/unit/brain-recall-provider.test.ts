import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ config: vi.fn(), generate: vi.fn() }));
vi.mock("@/lib/ai/user-llm-api-settings", () => ({ getUserLlmProviderConfig: mocks.config }));
vi.mock("ai", () => ({ generateText: mocks.generate }));
import { buildBrainRecallPlan } from "@/lib/brain/recall-planner";
const request = { requester: { type: "chat" as const, userId: "owner" }, taskIntent: "Explain project architecture" };
const plan = { searchTerms: ["architecture"], statuses: ["active"], routes: [{ route: "brain_memory", purpose: "canonical", enabled: true, reason: "facts" }] };
describe("recall provider compatibility", () => {
  it("uses optimized rules without calling Jev or the generative planner", async () => {
    vi.stubEnv("BRAIN_JEV_ROUTING", "replace"); vi.stubEnv("TYPESAFE_API_KEY", "test");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ answers: Object.fromEntries(
      ["architecture", "records", "knowledge", "brain"].map(source => [source, { type: "noul", noul: source === "knowledge" || source === "brain" ? 0.99 : 0.01 }]),
    ) })));
    const result = await buildBrainRecallPlan(request);
    expect(result.mode).toBe("rules");
    expect(result.routing).toBeUndefined();
    expect(result.routes.find(route => route.route === "knowledge_store")).toBeUndefined();
    expect(result.routes.find(route => route.route === "memory_graph")?.enabled).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.config).not.toHaveBeenCalled(); expect(mocks.generate).not.toHaveBeenCalled();
  });
  it("keeps source routing configuration independent of rules planning", async () => {
    vi.stubEnv("BRAIN_JEV_ROUTING", "replace"); vi.stubEnv("TYPESAFE_API_KEY", "test");
    vi.stubEnv("PLATFORM_RECALL_PREFETCH", "jev"); vi.stubEnv("PLATFORM_CAPABILITY_ROUTING", "jev");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("secret", { status: 503 })));
    const result = await buildBrainRecallPlan(request);
    expect(result.mode).toBe("rules");
    expect(result.warnings).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.config).not.toHaveBeenCalled(); expect(mocks.generate).not.toHaveBeenCalled();
  });
  beforeEach(() => {
    mocks.config.mockReset(); mocks.generate.mockReset();
    vi.stubEnv("PLATFORM_REASONING_MODE", "optimized");
    vi.stubEnv("BRAIN_RECALL_PLANNER", "");
    for (const prefix of ["BRAIN_RECALL_PLANNER_LLM", "MEMORY_RECALL_LLM", "LLM"]) for (const key of ["API_KEY", "BASE_URL", "MODEL"]) vi.stubEnv(`${prefix}_${key}`, "");
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
  it("uses the owner-configured LLM in the agent baseline despite all previous experiment flags", async () => {
    vi.stubEnv("PLATFORM_REASONING_MODE", "agent");
    vi.stubEnv("BRAIN_RECALL_PLANNER", "rules");
    vi.stubEnv("PLATFORM_RECALL_PREFETCH", "jev"); vi.stubEnv("PLATFORM_CAPABILITY_ROUTING", "jev");
    vi.stubEnv("BRAIN_JEV_ROUTING", "replace"); vi.stubEnv("BRAIN_JEV_MODE", "active");
    vi.stubEnv("BRAIN_JEV_TARGETED_RETRY", "true"); vi.stubEnv("TYPESAFE_API_KEY", "test");
    mocks.config.mockResolvedValue({ apiKey: "test-main", baseUrl: "http://localhost:1234/v1", model: "configured-main-model" });
    mocks.generate.mockResolvedValue({ text: JSON.stringify(plan) });
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const result = await buildBrainRecallPlan(request);
    expect(result.mode).toBe("llm");
    expect(result.searchTerms).toContain("architecture");
    expect(result.routing).toBeUndefined();
    expect(mocks.config).toHaveBeenCalledExactlyOnceWith({ userId: "owner", providerType: "openai_compatible" });
    expect(mocks.generate).toHaveBeenCalledOnce();
    expect(mocks.generate.mock.calls[0][0].model.modelId).toBe("configured-main-model");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("falls back to rules when the agent planner has no configured provider", async () => {
    vi.stubEnv("PLATFORM_REASONING_MODE", "agent");
    mocks.config.mockResolvedValue(undefined);
    const result = await buildBrainRecallPlan(request);
    expect(result.mode).toBe("fallback_rules");
    expect(result.warnings).toContain("llm_recall_planner_not_configured");
    expect(mocks.generate).not.toHaveBeenCalled();
  });
  it.each(["provider configuration unavailable", "postgres://private-user:private-password@localhost/private-db private-owner-detail"])("falls back safely when provider configuration throws: %s", async message => {
    vi.stubEnv("PLATFORM_REASONING_MODE", "agent");
    mocks.config.mockRejectedValue(Error(message));
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const result = await buildBrainRecallPlan(request);
    expect(result.mode).toBe("fallback_rules");
    expect(result.warnings).toEqual(["llm_recall_planner_configuration_unavailable"]);
    expect(JSON.stringify(result)).not.toContain(message);
    expect(JSON.stringify(result)).not.toContain("private-");
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("uses the owner's Anthropic configuration and routes OpenCode requests with a session header", async () => {
    vi.stubEnv("BRAIN_RECALL_PLANNER", "llm");
    mocks.config.mockImplementation(async ({providerType}) => providerType === "anthropic_compatible" ? { apiKey: "test-key", baseUrl: "https://opencode.ai/zen/go", model: "configured-model" } : undefined);
    const fetchMock = vi.fn(async () => Response.json({ content: [{type:"thinking",thinking:"ignored"},{type:"text",text:JSON.stringify(plan)}] }));
    vi.stubGlobal("fetch", fetchMock);
    expect((await buildBrainRecallPlan(request)).mode).toBe("llm");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://opencode.ai/zen/go/v1/messages");
    expect(init.headers).toMatchObject({ "anthropic-version": "2023-06-01", "x-opencode-session": expect.stringMatching(/^zhiyu-brain-recall-/) });
    expect(JSON.parse(init.body as string).model).toBe("configured-model");
    expect(mocks.generate).not.toHaveBeenCalled();
  });
  it("preserves configured OpenAI priority", async () => {
    vi.stubEnv("BRAIN_RECALL_PLANNER", "llm");
    mocks.config.mockResolvedValue({apiKey:"test",baseUrl:"http://localhost:1234/v1",model:"model"});
    mocks.generate.mockResolvedValue({text:JSON.stringify(plan)});
    expect((await buildBrainRecallPlan(request)).mode).toBe("llm");
    expect(mocks.config).toHaveBeenCalledTimes(1);
    expect(mocks.generate.mock.calls[0][0]).toMatchObject({maxRetries:0,abortSignal:expect.any(AbortSignal)});
  });
  it("exposes HTTP failure as fallback without copying provider payloads or secrets into audit warnings", async () => {
    vi.stubEnv("BRAIN_RECALL_PLANNER", "llm");
    mocks.config.mockImplementation(async ({providerType}) => providerType === "anthropic_compatible" ? {apiKey:"secret",baseUrl:"http://localhost:1234/v1",model:"model"} : undefined);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("sensitive-provider-detail",{status:503})));
    const result=await buildBrainRecallPlan(request);
    expect(result.mode).toBe("fallback_rules");
    expect(result.warnings.join(" ")).toContain("recall_provider_http_503");
    expect(result.warnings.join(" ")).not.toContain("sensitive");
  });
});
