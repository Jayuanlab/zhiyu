import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {createPaperMatchingModule} from '@/lib/runtime/paper-matching-module';
const owner='00000000-0000-4000-8000-000000000001',account='00000000-0000-4000-8000-000000000002';
beforeEach(()=>{vi.stubEnv('QUANT_PAPER_ACCOUNT_ID',account);vi.stubEnv('QUANT_PAPER_OWNER_ID',owner);});
afterEach(()=>vi.unstubAllEnvs());
it('retries the durable pending command with the same actor after unknown results and restart',async()=>{
  const store={prepare:vi.fn(async()=> 'stable-tick'),complete:vi.fn(async()=>true)};
  const submit=vi.fn().mockRejectedValueOnce(Error('paper_result_unknown')).mockResolvedValueOnce({commandId:'stable-tick',version:2,result:{status:'completed',matched:[],waiting:{}}});
  const signal=new AbortController().signal;
  await expect(createPaperMatchingModule(owner,store,submit).run(signal)).rejects.toThrow('paper_result_unknown');
  expect(store.complete).not.toHaveBeenCalled();
  await createPaperMatchingModule(owner,store,submit).run(signal);
  expect(submit.mock.calls[0]).toEqual(submit.mock.calls[1]);
  expect(submit.mock.calls[0][1]).toEqual({ownerId:owner,actorId:`scheduler:${owner}`,role:'scheduler'});
  expect(store.complete).toHaveBeenCalledTimes(1);
});
it('retains prepared work after cancellation without sending, and rejects missing migration before storage',async()=>{
  const controller=new AbortController(),submit=vi.fn();
  const store={prepare:vi.fn(async()=>{controller.abort(new Error('stopped'));return 'pending';}),complete:vi.fn(async()=>true)};
  await expect(createPaperMatchingModule(owner,store,submit).run(controller.signal)).rejects.toThrow('stopped');
  expect(submit).not.toHaveBeenCalled();expect(store.complete).not.toHaveBeenCalled();
  vi.stubEnv('QUANT_PAPER_ACCOUNT_ID','');store.prepare.mockClear();
  await expect(createPaperMatchingModule(owner,store,submit).run(new AbortController().signal)).rejects.toThrow('paper_migration_required');
  expect(store.prepare).not.toHaveBeenCalled();
});
