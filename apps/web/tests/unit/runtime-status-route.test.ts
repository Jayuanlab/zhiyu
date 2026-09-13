import {beforeEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({auth:vi.fn(),snapshot:vi.fn()}));
vi.mock('@/app/(auth)/auth',()=>({auth:mocks.auth}));
vi.mock('@/lib/runtime/status',()=>({getRuntimeStatusSnapshot:mocks.snapshot}));
import {GET} from '@/app/api/runtime/status/route';
beforeEach(()=>vi.resetAllMocks());
it('requires authentication and uses only the authenticated owner',async()=>{
  mocks.auth.mockResolvedValue(null);expect((await GET()).status).toBe(401);expect(mocks.snapshot).not.toHaveBeenCalled();
  mocks.auth.mockResolvedValue({user:{id:'authenticated-owner'}});mocks.snapshot.mockResolvedValue({worker:{state:'offline'}});
  expect((await GET()).status).toBe(200);expect(mocks.snapshot).toHaveBeenCalledWith('authenticated-owner');
});
it('does not expose database exception details to the client',async()=>{
  mocks.auth.mockResolvedValue({user:{id:'owner'}});mocks.snapshot.mockRejectedValue(Error('private database connection'));
  const logger=vi.spyOn(console,'error').mockImplementation(()=>{});
  try{const response=await GET();expect(response.status).toBe(503);expect(await response.json()).toEqual({error:'runtime_status_unavailable'});}finally{logger.mockRestore();}
});
