import { afterEach, describe, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ model: { id: "owner-model" }, load: vi.fn(), generate: vi.fn() }));
vi.mock("@/lib/ai/model-configuration", () => ({ createConfiguredTextModel: fixture.load }));
vi.mock("ai", () => ({ generateText: fixture.generate }));
import { triggerCompaction } from "@/lib/ai/compaction";
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
describe("server conversation compaction configuration", () => {
  it("uses the owner's selected model directly without forwarding a provider key to a Web API", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    fixture.load.mockResolvedValue(fixture.model);
    fixture.generate.mockResolvedValue({ text: "Summary", usage: { inputTokens: 20, outputTokens: 5 } });
    const result = await triggerCompaction({ userId: "owner", platform: "scheduler", level: "soft", messages: [{ role: "user", content: "Remember the project decision" }] });
    expect(fixture.load).toHaveBeenCalledWith({ userId: "owner", purpose: "conversation_compaction" });
    expect(fixture.generate.mock.calls[0][0].model).toBe(fixture.model);
    expect(fetch).not.toHaveBeenCalled();
    expect(result).toMatchObject({ summary: "Summary", originalTokens: 20, summaryTokens: 5 });
  });
  it("surfaces a failed configuration through the existing compaction failure result without trying another service", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    fixture.load.mockRejectedValue(new Error("model_config_incomplete"));
    expect(await triggerCompaction({ userId: "owner", platform: "scheduler", level: "soft", messages: [{ role: "user", content: "Project history" }] })).toBeNull();
    expect(fixture.generate).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
});
