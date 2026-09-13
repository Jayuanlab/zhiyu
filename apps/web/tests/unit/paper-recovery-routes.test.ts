import {beforeEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({auth:vi.fn(),prepare:vi.fn(),read:vi.fn(),decide:vi.fn()}));
vi.mock('@/app/(auth)/auth',()=>({auth:mocks.auth}));
vi.mock('@/lib/quant/paper-client',async importOriginal=>({...await importOriginal<typeof import('@/lib/quant/paper-client')>(),
  preparePaperRecoveryReview:mocks.prepare,readPaperRecoveryReview:mocks.read,decidePaperRecoveryReview:mocks.decide}));
import {POST as prepare} from '@/app/(chat)/api/quant/paper/migration/reviews/route';
import {GET as read,POST as decide} from '@/app/(chat)/api/quant/paper/migration/reviews/[reviewId]/route';
import {PaperCommandError} from '@/lib/quant/paper-client';
const context={params:Promise.resolve({reviewId:'review'})};
const request=(body:unknown={},actor='owner')=>new Request('http://localhost/api',{method:'POST',headers:{'X-Work-Actor':actor},body:JSON.stringify(body)});
const body={commandId:'stable',reviewHash:'a'.repeat(64),decision:'approved',acknowledgements:{historicalCashIncomplete:true,historicalPnlIncomplete:true,preserveCurrentBalances:true}};
beforeEach(()=>{vi.clearAllMocks();mocks.auth.mockResolvedValue({user:{id:'owner'}});mocks.prepare.mockResolvedValue({});mocks.read.mockResolvedValue({decision:'pending'});mocks.decide.mockResolvedValue({decision:'approved'});});
it('rejects missing identity and identity changes before preparing or deciding',async()=>{
  mocks.auth.mockResolvedValue(null);
  expect((await prepare(request())).status).toBe(401);
  expect((await read(request(),context)).status).toBe(401);
  mocks.auth.mockResolvedValue({user:{id:'other'}});
  expect((await decide(request(body),context)).status).toBe(409);
  expect(mocks.prepare).not.toHaveBeenCalled();expect(mocks.decide).not.toHaveBeenCalled();
});
it('passes only session owner and strictly rejects injected actor or string confirmations',async()=>{
  expect((await decide(request({...body,actor:'admin'}),context)).status).toBe(400);
  expect((await decide(request({...body,acknowledgements:{historicalCashIncomplete:'true'}}),context)).status).toBe(400);
  expect((await decide(request(body),context)).status).toBe(200);
  expect(mocks.decide).toHaveBeenCalledWith('owner','review',body);
});
it('preserves unknown result command and provides an uncached recovery query',async()=>{
  mocks.decide.mockRejectedValue(new PaperCommandError('paper_result_unknown',503,'stable'));
  const response=await decide(request(body),context);
  expect(response.status).toBe(503);expect(await response.json()).toEqual({error:'paper_result_unknown',commandId:'stable'});
  expect((await read(request(),context)).headers.get('Cache-Control')).toBe('no-store');
  expect(mocks.read).toHaveBeenCalledWith('owner','review');
});
