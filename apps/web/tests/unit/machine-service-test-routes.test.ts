import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  owner: 'owner' as string | null,
  start: vi.fn(),
  poll: vi.fn(),
  list: vi.fn(),
  media: vi.fn(),
  safe: vi.fn(),
}));
vi.mock('@/app/(auth)/auth', () => ({
  auth: async () => (state.owner ? { user: { id: state.owner } } : null),
}));
vi.mock('@/lib/ai/model-center-service', () => ({
  modelCenterErrorResponse: (error: any) =>
    Response.json(
      { error: error.code ?? 'invalid_configuration' },
      { status: error.status ?? 400 },
    ),
}));
vi.mock('@/lib/ai/machine-service-tests', () => ({
  startMachineServiceTest: state.start,
  pollMachineServiceTest: state.poll,
  listMachineServiceTests: state.list,
  readMachineTestMedia: state.media,
  safeMachineServiceTest: state.safe,
  readMachineTestJson: (request: Request) => request.json(),
}));
import {
  GET,
  POST,
} from '@/app/(chat)/api/preferences/models/machine/tests/route';
import { GET as poll } from '@/app/(chat)/api/preferences/models/machine/tests/[id]/route';
import { GET as media } from '@/app/(chat)/api/preferences/models/machine/tests/[id]/media/route';
const id = '11111111-1111-4111-8111-111111111111',
  base = 'http://127.0.0.1:3515';
const body = {
  id,
  kind: 'video',
  expectedRevision: '1'.repeat(64),
  updates: {},
};
function request(
  method = 'POST',
  payload: any = body,
  headers: Record<string, string> = {},
) {
  return new Request(base + '/api/preferences/models/machine/tests', {
    method,
    headers: {
      Host: '127.0.0.1:3515',
      Origin: base,
      'Content-Type': 'application/json',
      ...headers,
    },
    ...(method === 'POST' ? { body: JSON.stringify(payload) } : {}),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('AUTH_MODE', 'local_owner');
  state.owner = 'owner';
  state.start.mockResolvedValue({ id, state: 'pending' });
  state.poll.mockResolvedValue({ id, state: 'pending' });
  state.list.mockResolvedValue([]);
  state.safe.mockImplementation((value) => value);
  state.media.mockResolvedValue({
    bytes: new Uint8Array([1, 2, 3]),
    mimeType: 'audio/wav',
  });
});
afterEach(() => vi.unstubAllEnvs());
describe('machine service test HTTP boundaries', () => {
  it('does not invoke a provider for anonymous, non-owner mode or cross-site requests', async () => {
    state.owner = null;
    expect((await POST(request())).status).toBe(401);
    state.owner = 'owner';
    vi.stubEnv('AUTH_MODE', 'authenticated');
    expect((await POST(request())).status).toBe(403);
    vi.stubEnv('AUTH_MODE', 'local_owner');
    expect(
      (
        await POST(
          request('POST', body, { Origin: 'https://untrusted.invalid' }),
        )
      ).status,
    ).toBe(403);
    expect(
      (await GET(request('GET', undefined, { 'sec-fetch-site': 'cross-site' })))
        .status,
    ).toBe(403);
    expect(state.start).not.toHaveBeenCalled();
  });
  it('rejects body owner forgery and arbitrary configuration before adapter calls', async () => {
    expect(
      (await POST(request('POST', { ...body, ownerId: 'forged' }))).status,
    ).toBe(400);
    expect(state.start).not.toHaveBeenCalled();
  });
  it('passes the authenticated owner, exact revision, idempotency id and cancellation signal', async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(state.start).toHaveBeenCalledWith(
      'owner',
      body,
      expect.any(AbortSignal),
    );
    expect(await response.json()).toMatchObject({ state: 'pending' });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
  it('scopes list, poll and media to the authenticated owner', async () => {
    await GET(request('GET'));
    expect(state.list).toHaveBeenCalledWith('owner');
    await poll(request('GET'), { params: Promise.resolve({ id }) });
    expect(state.poll).toHaveBeenCalledWith(
      id,
      'owner',
      expect.any(AbortSignal),
    );
    const response = await media(request('GET'), {
      params: Promise.resolve({ id }),
    });
    expect(state.media).toHaveBeenCalledWith(id, 'owner');
    expect(response.headers.get('Cache-Control')).toContain('private');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([
      1, 2, 3,
    ]);
  });
});
