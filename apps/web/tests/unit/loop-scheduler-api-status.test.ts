import {beforeEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({auth:vi.fn(),status:vi.fn()}));
vi.mock('@/app/(auth)/auth',()=>({auth:mocks.auth}));
vi.mock('@/lib/runtime/bootstrap',()=>({bootstrapRuntimeForUser:mocks.status}));
vi.mock('@/lib/cron/local-scheduler',()=>{throw Error('legacy route must not load scheduler');});
vi.mock('@/lib/auth/token-manager',()=>{throw Error('legacy route must not load token writer');});
import {GET,POST} from '@/app/(chat)/api/scheduled-jobs/internal/scheduler/route';
beforeEach(()=>vi.resetAllMocks());
it('requires authentication for both legacy methods',async()=>{
  mocks.auth.mockResolvedValue(null);
  expect((await GET(new Request('http://localhost'))).status).toBe(401);
  expect((await POST()).status).toBe(401);expect(mocks.status).not.toHaveBeenCalled();
});
it('reads only authenticated owner status without using tokens from the URL',async()=>{
  mocks.auth.mockResolvedValue({user:{id:'owner'}});mocks.status.mockResolvedValue({startupRequested:false});
  const response=await GET(new Request('http://localhost?cloudAuthToken=must-not-be-used'));
  expect(response.status).toBe(200);expect(await response.json()).toEqual({startupRequested:false});
  expect(mocks.status).toHaveBeenCalledWith({userId:'owner'});expect(response.headers.get('cache-control')).toBe('no-store');
  expect((await POST()).status).toBe(410);
});
it('sanitizes status failures',async()=>{
  mocks.auth.mockResolvedValue({user:{id:'owner'}});mocks.status.mockRejectedValue(Error('private connection'));
  const response=await GET(new Request('http://localhost'));expect(response.status).toBe(503);
  expect(await response.json()).toEqual({error:'runtime_status_unavailable'});
});
