import {beforeEach,describe,expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({userId:'11111111-1111-4111-8111-111111111111' as string|null}));
vi.mock('@/app/(auth)/auth',()=>({auth:async()=>state.userId?{user:{id:state.userId}}:null}));
vi.mock('@/lib/memory/governance/canonical-backfill',()=>({prepareCanonicalBatch:vi.fn(),listCanonicalBatches:vi.fn(),readCanonicalBatch:vi.fn(),controlCanonicalBatch:vi.fn(),applyCanonicalBatchPage:vi.fn(),rollbackCanonicalBatchPage:vi.fn()}));
import {GET,POST} from '@/app/api/brain/backfill/route';
import {prepareCanonicalBatch,listCanonicalBatches} from '@/lib/memory/governance/canonical-backfill';
const batchId='22222222-2222-4222-8222-222222222222';
const post=(body:unknown)=>POST(new Request('http://localhost/api/brain/backfill',{method:'POST',body:JSON.stringify(body)}));
describe('backfill HTTP boundary',()=>{
  beforeEach(()=>{vi.resetAllMocks();state.userId='11111111-1111-4111-8111-111111111111';});
  it('requires authentication before reads and mutations',async()=>{
    state.userId=null;
    expect((await GET(new Request('http://localhost/api/brain/backfill'))).status).toBe(401);
    expect((await post({action:'prepare',batchId})).status).toBe(401);
    expect(prepareCanonicalBatch).not.toHaveBeenCalled();expect(listCanonicalBatches).not.toHaveBeenCalled();
  });
  it('rejects caller-supplied identity and malformed commands',async()=>{
    for(const payload of [{action:'prepare',batchId,userId:state.userId},{action:'prepare',batchId,limit:501},{action:'apply',batchId,planHash:'a'.repeat(64)},{action:'approve',batchId,planHash:'bad'},[],null])expect((await post(payload)).status).toBe(400);
    expect(prepareCanonicalBatch).not.toHaveBeenCalled();
  });
  it('uses the authenticated owner and does not leak database exceptions',async()=>{
    vi.mocked(prepareCanonicalBatch).mockRejectedValue(new Error('SQL private-content password=secret'));
    const response=await post({action:'prepare',batchId});
    expect(prepareCanonicalBatch).toHaveBeenCalledWith({action:'prepare',batchId,userId:state.userId});
    expect(response.status).toBe(503);expect(response.headers.get('cache-control')).toBe('no-store');
    const text=await response.text();expect(text).not.toContain('secret');expect(text).not.toContain('private-content');
  });
  it('requires command identity and reviewed version for every control',async()=>{
    for(const action of ['approve','pause','resume']){
      const input={action,batchId,planHash:'a'.repeat(64)};
      expect((await post({...input,commandId:batchId})).status).toBe(400);
      expect((await post({...input,expectedVersion:'1'})).status).toBe(400);
      expect((await post({...input,commandId:batchId,expectedVersion:1})).status).toBe(400);
    }
  });
});
