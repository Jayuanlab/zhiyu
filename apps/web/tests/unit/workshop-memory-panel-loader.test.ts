import { describe, expect, it, vi } from 'vitest';
import { createWorkshopReadClient } from '@/lib/workshops/read-client';
import { loadWorkshopMemoryPanel, type WorkshopMemoryQualityState } from '@/lib/workshops/memory-panel-loader';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

type Quality = { recallCount: number };
function setup() {
  const main = deferred<{ memories: Array<{ id: string }> }>();
  const quality = deferred<Quality>();
  const fetcher = vi.fn((url: string) => url.endsWith('/memories') ? main.promise : quality.promise);
  const client = createWorkshopReadClient(<T>(url: string) => fetcher(url) as Promise<T>);
  const states: WorkshopMemoryQualityState<Quality>[] = [];
  let currentId = 'work-a';
  const load = () => loadWorkshopMemoryPanel<{ id: string }, Quality>({
    workshopId: 'work-a', read: client.read, isCurrent: () => currentId === 'work-a',
    onQuality: state => states.push(state),
  });
  return { main, quality, fetcher, client, states, load, select: (id: string) => { currentId = id; } };
}

describe('Workshop memory panel loading', () => {
  it('finishes the primary list while quality is still pending and then publishes quality independently', async () => {
    const f = setup();
    const loaded = f.load();
    f.main.resolve({ memories: [{ id: 'memory-a' }] });
    expect(await loaded).toEqual({ memories: [{ id: 'memory-a' }] });
    expect(f.states.at(-1)).toMatchObject({ workshopId: 'work-a', status: 'loading', report: null, error: null });
    f.quality.resolve({ recallCount: 7 });
    await vi.waitFor(() => expect(f.states.at(-1)).toMatchObject({ status: 'ready', report: { recallCount: 7 } }));
  });

  it('reports quality failure without rejecting or withholding a successful list', async () => {
    const f = setup();
    const loaded = f.load();
    f.quality.reject(Error('quality timeout'));
    await vi.waitFor(() => expect(f.states.at(-1)).toMatchObject({ status: 'error', report: null, error: 'quality timeout' }));
    f.main.resolve({ memories: [{ id: 'memory-a' }] });
    expect(await loaded).toEqual({ memories: [{ id: 'memory-a' }] });
  });

  it.each(['ready', 'error'] as const)('ignores late quality %s after the selected Work changes', async status => {
    const f = setup();
    const loaded = f.load();
    f.main.resolve({ memories: [] });
    await loaded;
    f.select('work-b');
    if (status === 'ready') f.quality.resolve({ recallCount: 9 });
    else f.quality.reject(Error('old work unavailable'));
    await vi.waitFor(() => expect(f.client.getSnapshot().find(row => row.url.includes('memory-recall-quality'))?.status)
      .toBe(status === 'ready' ? 'ready' : 'error'));
    expect(f.states).toHaveLength(1);
    expect(f.states[0].status).toBe('loading');
  });

  it('preserves coalesced GETs when refresh is requested twice while both endpoints are pending', async () => {
    const f = setup();
    const first = f.load();
    const second = f.load();
    expect(first).toBe(second);
    f.main.resolve({ memories: [{ id: 'memory-a' }] });
    await first;
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    f.quality.resolve({ recallCount: 2 });
    await vi.waitFor(() => expect(f.states.at(-1)?.status).toBe('ready'));
  });

  it('keeps primary failure observable without waiting for quality completion', async () => {
    const f = setup();
    const loaded = f.load();
    f.main.reject(Error('memory list unavailable'));
    await expect(loaded).rejects.toThrow('memory list unavailable');
    expect(f.states.at(-1)?.status).toBe('loading');
    f.quality.resolve({ recallCount: 1 });
    await vi.waitFor(() => expect(f.states.at(-1)?.status).toBe('ready'));
  });
});
