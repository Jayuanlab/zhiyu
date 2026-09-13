import {beforeEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({auth:vi.fn(),list:vi.fn(),detail:vi.fn(),close:vi.fn()}));
vi.mock('@/app/(auth)/auth',()=>({auth:mocks.auth}));
vi.mock('@/lib/interactions/processing-reviews',()=>({listInteractionProcessingReviews:mocks.list,getInteractionProcessingReview:mocks.detail,closeInteractionProcessingReview:mocks.close,InteractionReviewConflict:class extends Error{}}));
import {GET,POST} from '@/app/api/interactions/processing-reviews/route';
beforeEach(()=>vi.resetAllMocks());
it('requires authentication and reads only the authenticated owner',async()=>{
  const request=new Request('http://localhost/api/interactions/processing-reviews?userId=foreign');
  mocks.auth.mockResolvedValue(null);expect((await GET(request)).status).toBe(401);expect(mocks.list).not.toHaveBeenCalled();
  mocks.auth.mockResolvedValue({user:{id:'owner'}});mocks.list.mockResolvedValue([]);
  const response=await GET(request);expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('no-store');expect(mocks.list).toHaveBeenCalledWith('owner',false);
});
it('requires explicit acknowledgement and same-origin authenticated decisions',async()=>{
  const body={jobId:'11111111-1111-4111-8111-111111111111',commandId:'22222222-2222-4222-8222-222222222222',attempt:1,acknowledgedUnknown:true};
  const request=(payload:unknown,origin='http://localhost')=>new Request('http://localhost/api/interactions/processing-reviews',{method:'POST',headers:{host:'localhost',origin,'content-type':'application/json'},body:JSON.stringify(payload)});
  mocks.auth.mockResolvedValue(null);expect((await POST(request(body))).status).toBe(401);
  mocks.auth.mockResolvedValue({user:{id:'owner'}});
  expect((await POST(request(body,'https://foreign.invalid'))).status).toBe(403);
  expect((await POST(request({...body,acknowledgedUnknown:false}))).status).toBe(400);
  expect(mocks.close).not.toHaveBeenCalled();mocks.close.mockResolvedValue({replayed:false});
  expect((await POST(request(body))).status).toBe(200);expect(mocks.close).toHaveBeenCalledWith({...body,userId:'owner'});
});
it('rejects invalid IDs, hides inaccessible reviews and sanitizes failures',async()=>{
  mocks.auth.mockResolvedValue({user:{id:'owner'}});
  expect((await GET(new Request('http://localhost?jobId=bad'))).status).toBe(400);
  mocks.detail.mockResolvedValue(null);
  expect((await GET(new Request('http://localhost?jobId=11111111-1111-4111-8111-111111111111'))).status).toBe(404);
  mocks.list.mockRejectedValue(Error('private connection details'));
  const response=await GET(new Request('http://localhost'));expect(response.status).toBe(503);expect(await response.json()).toEqual({error:'interaction_review_unavailable'});
});
it('requires the reviewed plan hash for resume and forwards the authenticated owner',async()=>{
  mocks.auth.mockResolvedValue({user:{id:'owner'}});mocks.close.mockResolvedValue({replayed:false});
  const body={jobId:'11111111-1111-4111-8111-111111111111',commandId:'22222222-2222-4222-8222-222222222222',attempt:1,acknowledgedUnknown:true,decision:'resume_plan'};
  const request=(value:unknown)=>new Request('http://localhost/api/interactions/processing-reviews',{method:'POST',headers:{host:'localhost',origin:'http://localhost','content-type':'application/json'},body:JSON.stringify(value)});
  expect((await POST(request(body))).status).toBe(400);expect(mocks.close).not.toHaveBeenCalled();
  expect((await POST(request({...body,planHash:'a'.repeat(64)}))).status).toBe(200);
  expect(mocks.close).toHaveBeenCalledWith({...body,planHash:'a'.repeat(64),userId:'owner'});
});
