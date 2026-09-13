import { afterEach, describe, expect, it, vi } from "vitest";
import { cachedQuantRead, invalidateQuantReadCache } from "@/lib/quant/cache";
import type { QuantCacheMeta } from "@/lib/quant/types";

type CachedValue<T> = {
  value: T;
  cache?: QuantCacheMeta;
};

describe("cachedQuantRead", () => {
  it("shortens warmup caching so completed provider data reaches the next poll", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const fetcher = vi.fn()
      .mockResolvedValueOnce({quality: {refreshing: true}, value: 1})
      .mockResolvedValueOnce({quality: {refreshing: false}, value: 2});
    await cachedQuantRead({key: "warming", fetcher});
    vi.setSystemTime(3_000);
    expect(await cachedQuantRead({key: "warming", fetcher})).toMatchObject({value: 2});
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("coalesces cold requests and prevents invalidated pending results from replacing newer data", async () => {
    let finish!: (value: {value: number}) => void;
    const fetcher = vi.fn(() => new Promise<{value: number}>(resolve => { finish = resolve; }));
    const first = cachedQuantRead({key: "cold", fetcher});
    const second = cachedQuantRead({key: "cold", fetcher});
    expect(fetcher).toHaveBeenCalledTimes(1);
    invalidateQuantReadCache(["cold"]);
    await cachedQuantRead({key: "cold", fetcher: async () => ({value: 2})});
    finish({value: 1});
    await Promise.all([first, second]);
    expect(await cachedQuantRead({key: "cold", fetcher})).toMatchObject({value: 2});
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
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
