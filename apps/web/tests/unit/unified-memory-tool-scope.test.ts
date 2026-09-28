import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ brain: vi.fn(), legacy: vi.fn() }));
vi.mock("@/lib/brain/service", () => ({ buildBrainContextFromMemoryRequest: mocks.brain }));
vi.mock("@/lib/memory/unified-search", () => ({ searchUnifiedMemory: mocks.legacy }));
import { searchUnifiedMemoryForUser, normalizeUnifiedMemorySources } from "@/lib/ai/unified-memory-tool";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.brain.mockResolvedValue({ items: [], selection: {}, recallPlan: {}, routeResults: [] });
  mocks.legacy.mockResolvedValue({ query: "q", sources: ["knowledge"], results: [], count: 0, warnings: [] });
});
describe("explicit memory source scope", () => {
  it("does not turn unknown or empty source selections into unrestricted defaults", async () => {
    expect(normalizeUnifiedMemorySources(["unknown"])).toEqual([]);
    await searchUnifiedMemoryForUser({ userId: "owner", query: "q", sources: [] });
    expect(mocks.brain).not.toHaveBeenCalled(); expect(mocks.legacy).not.toHaveBeenCalled();
  });
  it("does not search other sources when explicitly restricted to memory", async () => {
    await searchUnifiedMemoryForUser({ userId: "owner", query: "q", sources: ["memory"] });
    expect(mocks.brain).toHaveBeenCalledTimes(1);
    expect(mocks.brain).toHaveBeenCalledWith(expect.objectContaining({ accessMode: "owner_override", requester: expect.objectContaining({ type: "chat", userId: "owner" }) }));
    expect(mocks.legacy).not.toHaveBeenCalled();
  });
  it("preserves Work identity and never falls back to owner-wide discovery", async () => {
    const result = await searchUnifiedMemoryForUser({ userId: "owner", workId: "work-1", query: "q", sources: ["memory", "insights"] });
    expect(mocks.brain).toHaveBeenCalledWith(expect.objectContaining({ accessMode: "strict", discoverySources: [], requester: expect.objectContaining({ type: "work", id: "work-1" }) }));
    expect(mocks.legacy).not.toHaveBeenCalled();
    expect(result.text).toContain("scoped_discovery_unavailable");
  });
  it("does not read personal memory for a document-only query", async () => {
    await searchUnifiedMemoryForUser({ userId: "owner", query: "q", sources: ["knowledge"] });
    expect(mocks.brain).not.toHaveBeenCalled();
    expect(mocks.legacy).toHaveBeenCalledWith(expect.objectContaining({ sources: ["knowledge"], userId: "owner" }));
  });
});
