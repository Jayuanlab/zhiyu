import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ save: vi.fn(), auth: vi.fn() }));
vi.mock('@/app/(auth)/auth', () => ({ auth: mocks.auth }));
vi.mock('@/lib/memory/governance/recall-feedback', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/memory/governance/recall-feedback')>(), recordRecallFeedback: mocks.save,
}));
import { POST } from '@/app/api/memory/recall-feedback/route';
import { RecallFeedbackError } from '@/lib/memory/governance/recall-feedback';
const feedbackId = '00000000-0000-4000-8000-000000000001';
const valid = { feedbackId, query: 'audit', outcome: 'irrelevant' };
const request = (body: unknown) => new Request('http://localhost/api/memory/recall-feedback', {
  method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' },
}) as never;
describe('recall feedback route', () => {
  beforeEach(() => {
    mocks.auth.mockReset().mockResolvedValue({ user: { id: 'owner', email: 'owner@example.invalid' } });
    mocks.save.mockReset().mockResolvedValue({ id: feedbackId });
  });
  it('uses trusted identity and strips client association claims', async () => {
    const response = await POST(request({ ...valid, userId: 'attacker', selectedMemoryIds: ['forged'] }));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true, feedbackId });
    expect(mocks.save).toHaveBeenCalledWith({ ...valid, contextLogId: null, reason: '', sources: [], userId: 'owner', contactEmail: 'owner@example.invalid' });
  });
  it.each([{ ...valid, feedbackId: undefined }, { ...valid, outcome: 'rewrite_policy' }, { ...valid, contextLogId: 'invalid' }, null])('rejects invalid input %j', async body => {
    expect((await POST(request(body))).status).toBe(400); expect(mocks.save).not.toHaveBeenCalled();
  });
  it('requires a session owner', async () => {
    mocks.auth.mockResolvedValue({ user: {} });
    expect((await POST(request(valid))).status).toBe(401); expect(mocks.save).not.toHaveBeenCalled();
  });
  it.each([404, 409])('preserves domain error %i', async status => {
    mocks.save.mockRejectedValue(new RecallFeedbackError(status, 'Unavailable'));
    expect((await POST(request(valid))).status).toBe(status);
  });
  it('sanitizes infrastructure failures and reports retryable uncertainty', async () => {
    mocks.save.mockRejectedValue(new Error('secret SQL database credential'));
    const response = await POST(request(valid));
    expect(response.status).toBe(503); expect(await response.text()).not.toContain('secret');
  });
});
