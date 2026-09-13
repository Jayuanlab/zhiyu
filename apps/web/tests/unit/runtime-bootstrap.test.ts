import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ status: vi.fn(), auth: vi.fn() }));
vi.mock('@/lib/runtime/worker-status', () => ({ getRuntimeWorkerStatus: mocks.status }));
vi.mock('@/app/(auth)/auth', () => ({ auth: mocks.auth }));
vi.mock('@/lib/cron/local-scheduler', () => { throw Error('browser_must_not_load_scheduler'); });
vi.mock('@/lib/auth/token-manager', () => { throw Error('browser_must_not_write_cloud_token'); });
import { bootstrapRuntimeForUser } from '@/lib/runtime/bootstrap';
import { GET } from '@/app/api/runtime/bootstrap/route';
beforeEach(() => vi.resetAllMocks());
it('repeated browser observations read owner state without scheduling background work', async () => {
  vi.useFakeTimers();
  try {
    mocks.status.mockResolvedValue({ state: 'offline', online: false });
    for (let i = 0; i < 3; i++) {
      expect(await bootstrapRuntimeForUser({ userId: 'owner' })).toEqual({
        success: true, startupRequested: false, web: { online: true },
        generatedAt: expect.any(String),
        worker: { state: 'offline', online: false },
      });
    }
    expect(vi.getTimerCount()).toBe(0);
    expect(mocks.status.mock.calls).toEqual([['owner'], ['owner'], ['owner']]);
  } finally { vi.useRealTimers(); }
});
it('requires authentication and returns non-cacheable state for the authenticated owner', async () => {
  mocks.auth.mockResolvedValue(null);
  expect((await GET()).status).toBe(401);
  expect(mocks.status).not.toHaveBeenCalled();
  mocks.auth.mockResolvedValue({ user: { id: 'authenticated-owner' } });
  mocks.status.mockResolvedValue({ state: 'unavailable', online: null });
  const response = await GET();
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect((await response.json()).worker.online).toBeNull();
  expect(mocks.status).toHaveBeenCalledWith('authenticated-owner');
});
it('does not disclose exceptions', async () => {
  mocks.auth.mockResolvedValue({ user: { id: 'owner' } });
  mocks.status.mockRejectedValue(Error('private connection data'));
  const logger = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ success: false, error: 'runtime_status_unavailable' });
  } finally { logger.mockRestore(); }
});
