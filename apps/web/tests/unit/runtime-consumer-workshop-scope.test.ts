import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { JobExecutionResult } from '@/lib/cron/types';

const mocks = vi.hoisted(() => ({ execute: vi.fn(), claim: vi.fn() }));
vi.mock('@/lib/db/client', () => ({ db: { execute: mocks.execute } }));
vi.mock('@/lib/work-runtime/execution-context', () => ({ resolveExecutionLease: () => null }));
vi.mock('@/lib/work-runtime/execution-lease', () => ({ claimWorkshopExecution: mocks.claim }));
vi.mock('@/lib/workshops/service', () => ({ getWorkshop: vi.fn() }));
import { consumeOwnedLoopRuns } from '@/lib/work-runtime/loop-consumer';
import { consumeOwnedWorkRuns } from '@/lib/work-runtime/run-consumer';

const owner = '00000000-0000-4000-8000-000000000001';
const work = '00000000-0000-4000-8000-000000000002';
const other = '00000000-0000-4000-8000-000000000003';
const input = () => ({ userId: owner, workerId: 'official-worker', workshopIds: [work] });
beforeEach(() => { vi.clearAllMocks(); mocks.execute.mockResolvedValue([]); });

describe('official consumers enforce trusted workshop scope before claiming', () => {
  it.each([consumeOwnedLoopRuns, consumeOwnedWorkRuns])('places both owner and exact workshop bounds in candidate SQL', async consume => {
    await consume(input());
    const query = new PgDialect().sqlToQuery(mocks.execute.mock.calls[0][0]);
    expect(query.sql).toMatch(/w\.user_id=/);
    expect(query.sql).toMatch(/w\.id IN \(/);
    expect(query.params).toContain(owner);
    expect(query.params).toContain(work);
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it.each([{workshopIds:[]}, {workshopIds:['not-a-uuid']}, {workshopIds:[work, work]}])('rejects invalid scope %j before any database query', async ({workshopIds}) => {
    await expect(consumeOwnedLoopRuns({ ...input(), workshopIds })).rejects.toThrow('runtime_workshop_scope_invalid');
    await expect(consumeOwnedWorkRuns({ ...input(), workshopIds })).rejects.toThrow('runtime_workshop_scope_invalid');
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it('does not admit a foreign Loop candidate even if a stale/incorrect candidate reader returns it', async () => {
    const run = vi.fn();
    mocks.execute.mockResolvedValueOnce([{ run_id: 'foreign-run', workshop_id: other,
      request_json: { userId: owner, workId: other } }]);
    await expect(consumeOwnedLoopRuns(input(), run)).rejects.toThrow('runtime_workshop_scope_mismatch');
    expect(run).not.toHaveBeenCalled();
    expect(mocks.execute).toHaveBeenCalledOnce();
  });

  it('checks the accepted command scope independently from its candidate row', async () => {
    const run = vi.fn();
    mocks.execute.mockResolvedValueOnce([{ run_id: 'foreign-run', workshop_id: work,
      request_json: { userId: owner, workId: other } }]);
    await expect(consumeOwnedLoopRuns(input(), run)).rejects.toThrow('runtime_workshop_scope_mismatch');
    expect(run).not.toHaveBeenCalled();
    expect(mocks.execute).toHaveBeenCalledOnce();
  });

  it('does not claim a foreign Work candidate', async () => {
    mocks.execute.mockResolvedValueOnce([{ id: 'foreign-run', workshop_id: other }]);
    await expect(consumeOwnedWorkRuns(input())).rejects.toThrow('runtime_workshop_scope_mismatch');
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.execute).toHaveBeenCalledOnce();
  });

  it('still executes an allowed candidate through the existing coordinator and worker identity', async () => {
    const run = vi.fn(async (): Promise<JobExecutionResult> => ({ status: 'success', duration: 1, output: 'complete fixture' }));
    mocks.execute.mockResolvedValueOnce([{ run_id: 'allowed-run', workshop_id: work,
      request_json: { userId: owner, workId: work } }]).mockResolvedValueOnce([{ status: 'completed' }]);
    expect(await consumeOwnedLoopRuns(input(), run)).toEqual([{ runId: 'allowed-run', state: 'completed' }]);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ workId: work }),
      expect.objectContaining({ workerId: 'official-worker', acceptedRunId: 'allowed-run', leaseMs: 60000 }));
  });
});
