import {beforeEach,expect,it,vi} from 'vitest';
import {NextRequest} from 'next/server';
const mocks=vi.hoisted(()=>({auth:vi.fn(),list:vi.fn()}));
vi.mock('@/app/(auth)/auth',()=>({auth:mocks.auth}));
vi.mock('@/lib/work-runtime',()=>({listWorkEvents:mocks.list}));
import {GET} from '@/app/api/workshops/[id]/events/route';
const get=(query:string)=>GET(new NextRequest(`http://localhost/api/workshops/work/events?${query}`),{params:Promise.resolve({id:'work'})});
beforeEach(()=>{vi.resetAllMocks();mocks.auth.mockResolvedValue({user:{id:'owner'}});});
it('uses an exclusive before cursor with one lookahead and chronological response',async()=>{
  mocks.list.mockResolvedValue([{seq:3},{seq:4},{seq:5}]);
  const response=await get('pagination=history&limit=2&before=6');
  expect(mocks.list).toHaveBeenCalledWith(expect.objectContaining({userId:'owner',workId:'work',beforeSeq:6,limit:3,order:'latest'}));
  expect(await response.json()).toEqual({events:[{seq:4},{seq:5}],hasMore:true,nextBefore:4});
});
it('finishes a short page without inventing another cursor',async()=>{
  mocks.list.mockResolvedValue([{seq:1}]);
  expect(await (await get('pagination=history&limit=2&before=4')).json()).toEqual({events:[{seq:1}],hasMore:false,nextBefore:null});
});
it.each(['before=-1','before=NaN','before=1.5','after=1&before=2','pagination=history&after=0','limit=2001','limit=0'])('rejects invalid pagination %s',async query=>{
  expect((await get(query)).status).toBe(400);expect(mocks.list).not.toHaveBeenCalled();
});
it('does not query without authentication',async()=>{
  mocks.auth.mockResolvedValue(null);expect((await get('pagination=history')).status).toBe(401);expect(mocks.list).not.toHaveBeenCalled();
});
