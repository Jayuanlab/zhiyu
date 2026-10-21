import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
vi.mock('server-only', () => ({}));
vi.mock('@/app/(auth)/auth', () => ({ auth: vi.fn() }));
vi.mock('@/lib/work-runtime/execution-context', () => ({ resolveExecutionLease: vi.fn() }));
vi.mock('@/lib/memory/files/upload', () => ({ uploadWorkFile: vi.fn() }));
import { auth } from '@/app/(auth)/auth';
import { uploadWorkFile } from '@/lib/memory/files/upload';
import { MemoryModuleError } from '@/lib/memory/kernel/errors';
import { POST } from '@/app/api/workshops/[id]/sources/upload/route';
const userId = randomUUID(), workshopId = randomUUID(), commandId = randomUUID(), expiresAt = '2027-01-01T00:00:00.000Z';
function request(overrides: Record<string, string> = {}, origin = 'http://localhost') {
  const body = new FormData(); body.set('file', new File(['# Example\n'], 'report.md', { type: 'text/markdown' }));
  body.set('commandId', commandId); body.set('expiresAt', expiresAt); for (const [key, value] of Object.entries(overrides)) body.set(key, value);
  return new Request(`http://localhost/api/workshops/${workshopId}/sources/upload`, { method: 'POST', body, headers: { Host: 'localhost', Origin: origin } });
}
const params = { params: Promise.resolve({ id: workshopId }) };
beforeEach(() => { vi.clearAllMocks(); vi.mocked(auth).mockResolvedValue({ user: { id: userId } } as never);
  vi.mocked(uploadWorkFile).mockResolvedValue({ replayed: false, status: 'recorded', resultSemantics: 'command_result_at_revision', source: {}, binding: {} } as never); });
describe('document cleaner managed upload HTTP boundary', () => {
  it('passes authenticated owner, exact bytes and stable authorization command to the managed upload service', async () => {
    const response = await POST(request() as never, params); expect(response.status).toBe(201);
    expect(uploadWorkFile).toHaveBeenCalledWith(userId, { workshopId, commandId, expiresAt, name: 'report.md', contentType: 'text/markdown' }, new TextEncoder().encode('# Example\n'));
    expect(response.headers.get('cache-control')).toContain('no-store');
  });
  it('rejects unauthenticated, cross-origin, unknown fields and duplicate commands before storage', async () => {
    vi.mocked(auth).mockResolvedValue(null as never); expect((await POST(request() as never, params)).status).toBe(401);
    vi.mocked(auth).mockResolvedValue({ user: { id: userId } } as never);
    expect((await POST(request({}, 'https://foreign.invalid') as never, params)).status).toBe(403);
    expect((await POST(request({ userId: randomUUID() }) as never, params)).status).toBe(400);
    const body = await request().formData(); body.append('commandId', randomUUID());
    expect((await POST(new Request('http://localhost/api/workshops/' + workshopId + '/sources/upload', { method: 'POST', body, headers: { Host: 'localhost', Origin: 'http://localhost' } }) as never, params)).status).toBe(400);
    expect(uploadWorkFile).not.toHaveBeenCalled();
  });
  it('preserves explicit role/capacity/CAS failures and does not expose internal SQL', async () => {
    for (const status of [403, 404, 409]) {
      vi.mocked(uploadWorkFile).mockRejectedValueOnce(new MemoryModuleError('work_file_denied', status, 'Unavailable'));
      expect((await POST(request() as never, params)).status).toBe(status);
    }
    vi.mocked(uploadWorkFile).mockRejectedValueOnce(new Error('PRIVATE_SQL_UPLOAD_FAILURE'));
    const response = await POST(request() as never, params); expect(response.status).toBe(503); expect(await response.text()).not.toContain('PRIVATE_SQL');
  });
});
