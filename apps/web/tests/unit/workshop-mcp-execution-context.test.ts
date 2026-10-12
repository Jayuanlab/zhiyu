import {beforeEach,describe,it,expect,vi} from 'vitest';
import {resolveExecutionLease} from '@/lib/work-runtime/execution-context';
const mocks=vi.hoisted(()=>({get:vi.fn(),sources:vi.fn(),guard:vi.fn(),legacyReview:vi.fn(),brainReview:vi.fn(),place:vi.fn(),cancel:vi.fn(),step:vi.fn()}));
vi.mock('@/lib/quant/client',async original=>({...await original<typeof import('@/lib/quant/client')>(),placeQuantPaperOrder:mocks.place,cancelQuantPaperOrder:mocks.cancel}));
vi.mock('@/lib/work-runtime/recorded-step',()=>({applyRecordedStep:mocks.step}));
vi.mock('@anthropic-ai/claude-agent-sdk',async original=>({...await original<typeof import('@anthropic-ai/claude-agent-sdk')>(),createSdkMcpServer:(config:unknown)=>config}));
vi.mock('@/lib/workshops/service',async original=>({...await original<typeof import('@/lib/workshops/service')>(),getWorkshop:mocks.get,listWorkshopSources:mocks.sources,reviewWorkshopMemory:mocks.legacyReview}));
vi.mock('@/lib/brain/service',async original=>({...await original<typeof import('@/lib/brain/service')>(),reviewBrainMemory:mocks.brainReview}));
vi.mock('@/lib/work-runtime/execution-lease',async original=>({...await original<typeof import('@/lib/work-runtime/execution-lease')>(),withExecutionWrite:mocks.guard,withExecutionBusinessWrite:mocks.guard}));
import {createWorkshopMcpServer} from '@/lib/workshops/mcp-tools';
import {ExecutionLeaseError} from '@/lib/work-runtime/execution-errors';
import {MemoryDependencyError} from '@/lib/brain/memory-dependencies-common';
const lease={userId:'owner',workshopId:'work',runId:'run',workerId:'worker',token:1};
const workshop={id:'work',userId:'owner',modelConfig:{},boundaryPolicy:{}} as any;
function handler(capability=lease){
  const server=createWorkshopMcpServer({workshop,workshopId:'work',runId:'run',executionLease:capability}) as any;
  return server.tools.find((tool:any)=>tool.name==='workshopListSources').handler;
}
beforeEach(()=>{vi.clearAllMocks();mocks.get.mockResolvedValue(workshop);mocks.guard.mockResolvedValue(undefined);mocks.sources.mockImplementation(async()=>{await Promise.resolve();return [resolveExecutionLease()];});});
describe('actual workshop MCP wrapper',()=>{
  it('binds paper intent to the current run, owner and policy and records secondary events through a stable step',async()=>{
    const trader={...workshop,modelConfig:{role:'paper_trader'}};
    mocks.get.mockResolvedValue(trader);
    mocks.guard.mockImplementation(async(_lease,write)=>write({db:{execute:async()=>[{hash:'a'.repeat(32)}]}}));
    mocks.step.mockResolvedValue({orderId:'po_test'});
    const receipt={order:{id:'po_test',name:'test',code:'159278.SZ',status:'submitted'}};
    mocks.place.mockResolvedValue(receipt);
    const server=createWorkshopMcpServer({workshop:trader,workshopId:'work',runId:'run',executionLease:lease}) as any;
    const invoke=server.tools.find((tool:any)=>tool.name==='quantPaperPlaceOrder').handler;
    const args={commandId:'00000000-0000-4000-8000-000000000009',code:'159278.SZ',side:'buy',quantity:100,limitPrice:0.957,plannedPrice:0.95,note:'isolated test'};
    await invoke(args,{});await invoke(args,{});
    expect(mocks.place.mock.calls[0]).toEqual(mocks.place.mock.calls[1]);
    expect(mocks.place.mock.calls[0][0]).toMatchObject({commandId:`work:run:${args.commandId}`});
    expect(mocks.place.mock.calls[0][1]).toEqual({ownerId:'owner',actorId:'work:work:owner:owner',role:'trader',execution:{workshopId:'work',runId:'run',workerId:'worker',token:1,policyHash:'a'.repeat(32)}});
    expect(mocks.step).toHaveBeenCalledWith(expect.anything(),lease,`paper-order:work:run:${args.commandId}`,0,expect.any(Function));
  });
  it('requires a real trader lease before paper dispatch',async()=>{
    const trader={...workshop,modelConfig:{role:'paper_trader'}};mocks.get.mockResolvedValue(trader);
    const server=createWorkshopMcpServer({workshop:trader,workshopId:'work',runId:'run'}) as any;
    await expect(server.tools.find((tool:any)=>tool.name==='quantPaperCancelOrder').handler({orderId:'po_1',commandId:'00000000-0000-4000-8000-000000000009'},{})).rejects.toThrow('invalid_lease');
    expect(mocks.cancel).not.toHaveBeenCalled();
  });
  it.each([['active','active'],['weakened','weakened'],['verified','confirmed'],['dismissed','dismissed']])('preserves review intent %s',async(decision,expected)=>{
    mocks.legacyReview.mockResolvedValue(null);
    mocks.brainReview.mockResolvedValue({id:'memory',userId:'owner',ownerId:'work',ownerType:'work',scope:{type:'work',workId:'work'},memoryType:'fact',content:'fact',status:decision==='dismissed'?'deleted':decision,evidenceRefs:[],tags:[],confidence:50});
    const server=createWorkshopMcpServer({workshop,workshopId:'work',runId:'run',executionLease:lease}) as any;
    await server.tools.find((tool:any)=>tool.name==='workshopReviewMemory').handler({memoryId:'memory',decision,reason:'review'},{});
    expect(mocks.brainReview).toHaveBeenCalledWith(expect.objectContaining({memoryId:'memory',decision:expected}));
  });
  it('does not disguise mid-review lease loss as a missing memory',async()=>{
    mocks.legacyReview.mockResolvedValue(null);mocks.brainReview.mockRejectedValue(new ExecutionLeaseError('lease_lost'));
    const server=createWorkshopMcpServer({workshop,workshopId:'work',runId:'run',executionLease:lease}) as any;
    await expect(server.tools.find((tool:any)=>tool.name==='workshopReviewMemory').handler({memoryId:'memory',decision:'weakened',reason:'review'},{})).rejects.toThrow('lease_lost');
  });
  it('propagates the server capability into the asynchronous tool handler',async()=>{
    const result=await handler()({},{});
    expect(result.data.sources).toEqual([lease]);expect(mocks.guard).toHaveBeenCalledWith(lease,expect.any(Function));
    expect(resolveExecutionLease()).toBeUndefined();
  });
  it('rejects mismatched run identity before tool or database work',async()=>{
    await expect(handler({...lease,runId:'another'})({},{})).rejects.toThrow('invalid_lease');
    expect(mocks.guard).not.toHaveBeenCalled();expect(mocks.sources).not.toHaveBeenCalled();
  });
  it('captures the capability when the server is created',async()=>{
    const mutable={...lease},invoke=handler(mutable);mutable.token=99;
    expect((await invoke({},{})).data.sources).toEqual([lease]);
  });
  it('does not dispatch a tool after the lease check fails',async()=>{
    mocks.guard.mockRejectedValueOnce(Error('lease_lost'));
    await expect(handler()({},{})).rejects.toThrow('lease_lost');expect(mocks.sources).not.toHaveBeenCalled();
  });
  it('does not dispatch a tool after the recorded memory basis becomes stale',async()=>{
    const error=new MemoryDependencyError('memory_dependency_stale',409,'Recorded sources require review');
    mocks.guard.mockRejectedValueOnce(error);
    await expect(handler()({},{})).rejects.toBe(error);
    expect(mocks.sources).not.toHaveBeenCalled();
  });
});
