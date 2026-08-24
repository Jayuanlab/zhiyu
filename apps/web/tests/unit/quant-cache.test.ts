import { afterEach, describe, expect, it, vi } from "vitest";
import { cachedQuantRead, invalidateQuantReadCache } from "@/lib/quant/cache";
import type { QuantCacheMeta } from "@/lib/quant/types";

type CachedValue<T> = {
  value: T;
  cache?: QuantCacheMeta;
};

describe("cachedQuantRead", () => {
  afterEach(() => {
    invalidateQuantReadCache();
    vi.useRealTimers();
  });

  it("returns stale data immediately and refreshes expired entries in the background", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);

    let calls = 0;
    const fetcher = vi.fn(async (): Promise<CachedValue<number>> => ({
      value: ++calls,
    }));

    const fresh = await cachedQuantRead({
      key: "quant:test",
      fetcher,
      ttlMs: 100,
      staleTtlMs: 1_000,
    });

    expect(fresh).toMatchObject({
      value: 1,
      cache: {
        hit: false,
        stale: false,
      },
    });

    vi.setSystemTime(1_200);

    const stale = await cachedQuantRead({
      key: "quant:test",
      fetcher,
      ttlMs: 100,
      staleTtlMs: 1_000,
    });

    expect(stale).toMatchObject({
      value: 1,
      cache: {
        hit: true,
        stale: true,
        refreshing: true,
      },
    });
    expect(fetcher).toHaveBeenCalledTimes(2);

    await vi.runAllTicks();

    const refreshed = await cachedQuantRead({
      key: "quant:test",
      fetcher,
      ttlMs: 100,
      staleTtlMs: 1_000,
    });

    expect(refreshed).toMatchObject({
      value: 2,
      cache: {
        hit: true,
        stale: false,
      },
    });
  });

  it("falls back to stale data when the stale window expired but refresh fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);

    await cachedQuantRead({
      key: "quant:test:error",
      fetcher: async (): Promise<CachedValue<string>> => ({
        value: "snapshot",
      }),
      ttlMs: 100,
      staleTtlMs: 100,
    });

    vi.setSystemTime(1_300);

    const stale = await cachedQuantRead({
      key: "quant:test:error",
      fetcher: async (): Promise<CachedValue<string>> => {
        throw new Error("provider down");
      },
      ttlMs: 100,
      staleTtlMs: 100,
    });

    expect(stale).toMatchObject({
      value: "snapshot",
      cache: {
        hit: true,
        stale: true,
        refreshing: false,
      },
    });
    expect(stale.cache?.warning).toContain("provider down");
  });
});
