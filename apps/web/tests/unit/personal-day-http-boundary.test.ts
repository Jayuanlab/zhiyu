import { beforeEach, describe, it, expect, vi } from 'vitest';
const auth = vi.hoisted(() => vi.fn());
vi.mock('@/app/(auth)/auth', () => ({ auth }));
import { dayOwner, dayJson, dayErrorResponse } from '@/lib/personal-day/http';
const owner = '11111111-1111-4111-a111-111111111111';
const request = (
  headers: Record<string, string> = {},
  method = 'GET',
  body?: string,
) =>
  new Request('http://localhost:3515/api/personal-day', {
    method,
    headers: { host: '127.0.0.1:3515', ...headers },
    ...(body ? { body } : {}),
  });
beforeEach(() => {
  auth.mockResolvedValue({ user: { id: owner } });
});
describe('personal day private HTTP boundary', () => {
  it('requires a real session', async () => {
    auth.mockResolvedValue(null);
    await expect(dayOwner(request())).rejects.toThrow('unauthorized');
  });
  it('accepts Next loopback normalization while retaining exact public origin', async () => {
    await expect(
      dayOwner(request({ origin: 'http://127.0.0.1:3515' }, 'POST', '{}')),
    ).resolves.toBe(owner);
  });
  it.each([
    { origin: 'https://evil.example.invalid' },
    { 'sec-fetch-site': 'cross-site' },
    { host: 'evil.example.invalid' },
  ])('rejects cross-origin reads and writes %o', async (headers) => {
    await expect(dayOwner(request(headers))).rejects.toThrow(
      'same_origin_required',
    );
  });
  it('rejects a stale actor after a session switch', async () => {
    await expect(
      dayOwner(
        request({
          'X-Personal-Day-Actor': '22222222-2222-4222-a222-222222222222',
        }),
      ),
    ).rejects.toThrow('actor_changed');
  });
  it('rejects invalid JSON without leaking submitted body', async () => {
    await expect(
      dayJson(
        request(
          { origin: 'http://127.0.0.1:3515' },
          'POST',
          'private invalid json',
        ),
      ),
    ).rejects.toThrow('invalid_input');
  });
  it('never exposes SQL, credentials or model exception details', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = dayErrorResponse(new Error('private sql and credential'));
    expect(await response.json()).toEqual({
      error: 'daily_service_unavailable',
    });
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    spy.mockRestore();
  });
});
