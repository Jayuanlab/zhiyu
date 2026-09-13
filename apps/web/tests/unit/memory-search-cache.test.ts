import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cachedUnifiedMemorySearch,
  clearUnifiedMemorySearchCache,
} from "@/lib/memory/search-cache";
import type {
  UnifiedMemorySearchInput,
  UnifiedMemorySearchOutput,
} from "@/lib/memory/unified-search";

function input(overrides: Partial<UnifiedMemorySearchInput> = {}) {
  return {
    userId: "user-a",
    query: "盘中交易",
    sources: ["memory" as const],
    limit: 5,
    threshold: 0.5,
    ...overrides,
  };
}

function output(id: string): UnifiedMemorySearchOutput {
  return {
    query: "盘中交易",
    sources: ["memory"],
    resultKind: "legacy_discovery",
    sourceSemantics: {
      memory: "canonical_context_candidate",
      insights: "legacy_discovery",
      knowledge: "evidence_source",
      interactions: "legacy_discovery",
      graph: "derived_index",
    },
    sourceStatuses: [
      {
        source: "memory",
        status: "ok",
        elapsedMs: 1,
        resultCount: 1,
        warningCount: 0,
        semantics: "canonical_context_candidate",
      },
    ],
    results: [
      {
        type: "memory",
        id,
        content: `memory ${id}`,
        similarity: 0.9,
        metadata: {},
      },
    ],
    count: 1,
    warnings: [],
  };
}

describe("cachedUnifiedMemorySearch", () => {
  afterEach(() => {
    clearUnifiedMemorySearchCache();
    vi.useRealTimers();
    delete process.env.MEMORY_SEARCH_CACHE_TTL_MS;
    delete process.env.MEMORY_SEARCH_CACHE_STALE_TTL_MS;
  });

  it("serves identical search requests from cache", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    process.env.MEMORY_SEARCH_CACHE_TTL_MS = "1000";

    const fetcher = vi.fn(async () => output("first"));

    const first = await cachedUnifiedMemorySearch(input(), fetcher);
    const second = await cachedUnifiedMemorySearch(input(), fetcher);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(first.cache.hit).toBe(false);
    expect(second.cache.hit).toBe(true);
    expect(second.results[0]?.id).toBe("first");
  });

  it("keeps cache entries isolated by user", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    process.env.MEMORY_SEARCH_CACHE_TTL_MS = "1000";

    const fetcherA = vi.fn(async () => output("user-a-memory"));
    const fetcherB = vi.fn(async () => output("user-b-memory"));

    await cachedUnifiedMemorySearch(input({ userId: "user-a" }), fetcherA);
    const userB = await cachedUnifiedMemorySearch(
      input({ userId: "user-b" }),
      fetcherB,
    );

    expect(fetcherA).toHaveBeenCalledTimes(1);
    expect(fetcherB).toHaveBeenCalledTimes(1);
    expect(userB.cache.hit).toBe(false);
    expect(userB.results[0]?.id).toBe("user-b-memory");
  });

  it("ignores deprecated legacy raw-message mode in cache keys", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    process.env.MEMORY_SEARCH_CACHE_TTL_MS = "1000";

    const canonicalFetcher = vi.fn(async () => output("canonical"));
    const legacyFetcher = vi.fn(async () => output("legacy"));

    await cachedUnifiedMemorySearch(input(), canonicalFetcher);
    const legacy = await cachedUnifiedMemorySearch(
      input({ includeLegacyMemory: true }),
      legacyFetcher,
    );

    expect(canonicalFetcher).toHaveBeenCalledTimes(1);
    expect(legacyFetcher).not.toHaveBeenCalled();
    expect(legacy.cache.hit).toBe(true);
    expect(legacy.results[0]?.id).toBe("canonical");
  });

  it("returns stale search results immediately and refreshes in background", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    process.env.MEMORY_SEARCH_CACHE_TTL_MS = "100";
    process.env.MEMORY_SEARCH_CACHE_STALE_TTL_MS = "1000";

    let calls = 0;
    const fetcher = vi.fn(async () => output(`result-${++calls}`));

    await cachedUnifiedMemorySearch(input(), fetcher);

    vi.setSystemTime(1_200);

    const stale = await cachedUnifiedMemorySearch(input(), fetcher);

    expect(stale.cache).toMatchObject({
      hit: true,
      stale: true,
      refreshing: true,
    });
    expect(stale.results[0]?.id).toBe("result-1");
    expect(fetcher).toHaveBeenCalledTimes(2);

    await vi.runAllTicks();

    const refreshed = await cachedUnifiedMemorySearch(input(), fetcher);

    expect(refreshed.cache).toMatchObject({
      hit: true,
      stale: false,
    });
    expect(refreshed.results[0]?.id).toBe("result-2");
  });
});
