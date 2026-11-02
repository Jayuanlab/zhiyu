import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveModelConfiguration as resolve, modelApiUrl, describeModelConfiguration, validateModelConnectionUpdate } from "@openzhiyu/shared/model-configuration";
import type { ModelPurpose } from "@openzhiyu/shared/model-configuration";

const store = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("@/lib/ai/user-llm-api-settings", () => ({ getUserLlmProviderConfig: store.load }));
vi.mock("@/lib/ai/model-center-store",()=>({readModelCenterSnapshot:async()=>null}));
import { loadModelConfiguration, loadConversationModelConfiguration } from "@/lib/ai/model-configuration";

const openai = { apiKey: "owner-key", baseUrl: "https://owner.invalid/v1", model: "owner-model" };
const anthropic = { apiKey: "agent-key", baseUrl: "https://agent.invalid/v1", model: "agent-model" };
const env = { LLM_API_KEY: "system-key", LLM_BASE_URL: "https://system.invalid/v1", LLM_MODEL: "system-model" };
afterEach(() => { vi.unstubAllEnvs(); store.load.mockReset(); });

describe("one complete model connection per purpose", () => {
  it.each(["text", "workshop_planner", "loop_parser", "recall_planner", "loop_checker", "vision"] as ModelPurpose[])("%s uses the owner's saved connection before system defaults", purpose => {
    expect(resolve({ purpose, users: { openai_compatible: openai }, env })).toMatchObject({ ...openai, protocol: "openai_compatible", source: "user:openai_compatible" });
  });
  it("uses an OpenAI connection for the Pi executor", () => {
    expect(resolve({ purpose: "agent", users: { openai_compatible: openai }, env })).toMatchObject({...openai,protocol:"openai_compatible"});
  });
  it("selects a complete purpose-specific connection without mixing user credentials", () => {
    const role = { WORKSHOP_PLANNER_LLM_API_KEY: "planner-key", WORKSHOP_PLANNER_LLM_BASE_URL: "https://planner.invalid", WORKSHOP_PLANNER_LLM_MODEL: "planner" };
    expect(resolve({ purpose: "workshop_planner", users: { openai_compatible: openai }, env: { ...env, ...role } })).toMatchObject({ apiKey: "planner-key", baseUrl: "https://planner.invalid/v1", model: "planner", source: "env:WORKSHOP_PLANNER_LLM" });
  });
  it("fails an incomplete explicit host override rather than sending another connection's key", () => {
    expect(() => resolve({ purpose: "loop_parser", env: { ...env, LOOP_NL_LLM_BASE_URL: "https://wrong-host.invalid" }, users: { openai_compatible: openai } })).toThrow("model_config_incomplete: env:LOOP_NL_LLM");
  });
  it("allows a model-only override on the selected connection", () => {
    expect(resolve({ purpose: "loop_parser", env: { ...env, LOOP_NL_LLM_MODEL: "parser" }, users: { openai_compatible: openai } })).toMatchObject({ apiKey: openai.apiKey, baseUrl: openai.baseUrl, model: "parser" });
  });
  it("keeps aliases atomic rather than borrowing fields between old and new names", () => {
    expect(() => resolve({ purpose: "recall_planner", env: { BRAIN_RECALL_PLANNER_LLM_BASE_URL: "https://a.invalid", MEMORY_RECALL_LLM_API_KEY: "b-key", MEMORY_RECALL_LLM_MODEL: "b" } })).toThrow("model_config_incomplete");
  });
  it("uses explicit Anthropic authentication consistently and does not borrow LLM_*", () => {
    const config = resolve({ purpose: "agent", env: { ANTHROPIC_AUTH_TOKEN: "token", ANTHROPIC_MODEL: "agent" } });
    expect(config).toMatchObject({ apiKey: "token", baseUrl: "https://api.anthropic.com", model: "agent" });
  });
  it("applies tiers as model-only overrides or complete Anthropic connections", () => {
    expect(resolve({ purpose: "agent", tier: "cheap", env: { LLM_CHEAP_MODEL: "fast" }, users: { anthropic_compatible: anthropic } })).toMatchObject({ apiKey: "agent-key", model: "fast", baseUrl: "https://agent.invalid" });
    expect(() => resolve({ purpose: "agent", tier: "cheap", env: { LLM_CHEAP_BASE_URL: "https://other.invalid" }, users: { anthropic_compatible: anthropic } })).toThrow("model_config_incomplete");
  });
  it("normalizes runtime and test URLs identically", () => {
    for (const input of ["https://a.invalid", "https://a.invalid/v1/", "https://a.invalid/v1/messages", "https://a.invalid/v1/chat/completions"]) {
      expect(modelApiUrl(input, "messages")).toBe("https://a.invalid/v1/messages");
      expect(modelApiUrl(input, "chat/completions")).toBe("https://a.invalid/v1/chat/completions");
    }
    expect(modelApiUrl("https://a.invalid/api/paas/v4", "chat/completions")).toBe("https://a.invalid/api/paas/v4/chat/completions");
    expect(modelApiUrl("https://a.invalid/v1beta/openai", "chat/completions")).toBe("https://a.invalid/v1beta/openai/chat/completions");
  });
  it("does not serialize credentials into diagnostics or configuration errors", () => {
    const config = resolve({ purpose: "text", users: { openai_compatible: openai } });
    expect(JSON.stringify(describeModelConfiguration(config))).not.toContain("owner-key");
    expect(() => resolve({ purpose: "text", users: { openai_compatible: { ...openai, baseUrl: "https://key:secret@bad.invalid" } } })).toThrow("model_config_invalid_url: user:openai_compatible");
  });
  it("uses explicit vision selection with a saved connection without a separate deployment text key", () => {
    expect(resolve({ purpose: "vision", users: { openai_compatible: openai }, env: { LLM_VISION_LANGUAGE_MODEL: "vision" } })).toMatchObject({ apiKey: "owner-key", model: "vision" });
  });
  it("does not treat a text model as an image-generation model", () => {
    expect(resolve({ purpose: "image", users: { openai_compatible: openai }, env })).toBeUndefined();
  });
});

describe("Web and worker use the same owner-scoped lookup", () => {
  it("observes the next saved configuration without global caches, while an existing operation keeps its snapshot", async () => {
    store.load.mockResolvedValueOnce(openai).mockResolvedValueOnce({ ...openai, apiKey: "rotated", model: "new-model" });
    const first = await loadModelConfiguration({ userId: "owner", purpose: "workshop_planner", env: {} });
    const next = await loadModelConfiguration({ userId: "owner", purpose: "workshop_planner", env: {} });
    expect(first?.apiKey).toBe("owner-key"); expect(next?.apiKey).toBe("rotated"); expect(Object.isFrozen(first)).toBe(true);
  });
  it("keeps two owners isolated when lookups finish in reverse order", async () => {
    let release!: (value: typeof openai) => void;
    store.load.mockImplementation(({ userId }) => userId === "a" ? new Promise(resolve => { release = resolve; }) : Promise.resolve({ ...openai, apiKey: "b-key" }));
    const a = loadModelConfiguration({ userId: "a", purpose: "loop_parser", env: {} });
    const b = await loadModelConfiguration({ userId: "b", purpose: "loop_parser", env: {} });
    release(openai); expect((await a)?.apiKey).toBe("owner-key"); expect(b?.apiKey).toBe("b-key");
  });
  it("fails closed when saved configuration cannot be read", async () => {
    store.load.mockRejectedValue(new Error("database_unavailable"));
    await expect(loadModelConfiguration({ userId: "owner", purpose: "text", env })).rejects.toThrow("database_unavailable");
  });
  it("does not read an unused default connection when the purpose has a complete independent connection", async () => {
    store.load.mockRejectedValue(new Error("unused_default_unavailable"));
    const config = await loadModelConfiguration({ userId: "owner", purpose: "loop_parser", env: {
      LOOP_NL_LLM_API_KEY: "parser", LOOP_NL_LLM_BASE_URL: "https://parser.invalid/v1", LOOP_NL_LLM_MODEL: "parser",
    } });
    expect(config?.apiKey).toBe("parser"); expect(store.load).not.toHaveBeenCalled();
  });
  it("uses a saved OpenAI conversation connection instead of unrelated deployment Anthropic defaults", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "system-agent-key"); vi.stubEnv("ANTHROPIC_MODEL", "system-agent");
    store.load.mockImplementation(({ providerType }) => Promise.resolve(providerType === "openai_compatible" ? openai : undefined));
    expect(await loadConversationModelConfiguration("owner")).toMatchObject({ protocol: "openai_compatible", apiKey: "owner-key" });
  });
});

describe("save/test connection validation", () => {
  const previous = { ...openai, enabled: true };
  it("rejects a host change that would retain the previous host's secret", () => {
    expect(() => validateModelConnectionUpdate({ previous, next: { baseUrl: "https://other.invalid/v1" } })).toThrow("model_config_host_change_requires_key");
  });
  it("permits a complete replacement and a same-connection model change", () => {
    expect(validateModelConnectionUpdate({ previous, next: { apiKey: "replacement", baseUrl: "https://other.invalid/v1", model: "other" } })).toBe("https://other.invalid/v1");
    expect(validateModelConnectionUpdate({ previous, next: { model: "other" } })).toBe(openai.baseUrl);
  });
  it("treats equivalent SDK URL forms as the same connection", () => {
    expect(validateModelConnectionUpdate({ protocol: "anthropic_compatible", previous: { ...anthropic, enabled: true }, next: { baseUrl: "https://agent.invalid" } })).toBe("https://agent.invalid");
  });
  it("permits disabled drafts, but not enabling an incomplete connection", () => {
    expect(validateModelConnectionUpdate({ next: { baseUrl: "https://new.invalid", enabled: false } })).toBe("https://new.invalid/v1");
    expect(() => validateModelConnectionUpdate({ next: { baseUrl: "https://new.invalid", enabled: true } })).toThrow("model_config_incomplete");
  });
});
