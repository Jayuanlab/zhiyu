import {beforeEach,describe,expect,it,vi} from 'vitest';
import type {BrainMemory,BrainRequester} from '@/lib/brain/types';
import {buildBrainContextPack} from '@/lib/brain/context';
import {buildRuleBasedBrainRecallPlan} from '@/lib/brain/recall-planner';
import {scopeMatches} from '@/lib/brain/policy';

const state=vi.hoisted(()=>({request:null as any,pack:null as any,plan:null as any}));
vi.mock('@/lib/workshops/service',()=>({
  getWorkshop:vi.fn(async(userId:string,id:string)=>userId==='owner'&&id==='work-a'?{id,userId,name:'Hunter',modelConfig:{},boundary:{}}:null),
  listWorkshopSources:vi.fn(async()=>[]),listWorkshopMemories:vi.fn(async()=>[]),
  listActiveDirectives:vi.fn(async()=>[]),listWorkshopEvents:vi.fn(async()=>[]),appendWorkshopEvent:vi.fn(),
}));
vi.mock('@/lib/workshops/boundary-policy',()=>({workshopBoundaryToLoopPolicies:()=>({actionPolicy:{},approvalPolicy:{},metadata:{}})}));
vi.mock('@/lib/ai/context-profile',()=>({resolveLoopContextProfile:()=>({})}));
vi.mock('@/lib/loops/context-window',()=>({prepareLoopWorkshopContext:(x:any)=>x}));
vi.mock('@/lib/brain/service',()=>({buildBrainContextFromMemoryRequest:vi.fn(async(request:any)=>{
  state.request=request;
  state.plan=buildRuleBasedBrainRecallPlan(request);
  const memories=fixtures().filter(m=>!state.plan.scopes?.length||state.plan.scopes.some((s:any)=>scopeMatches(s,m.scope)));
  state.pack=buildBrainContextPack({memories,requester:request.requester,taskIntent:request.taskIntent,now:new Date('2026-09-11T00:00:00Z')});
  return {...state.pack,recallPlan:state.plan,explanation:{},routeResults:[]};
})}));
import {loadWorkshopContextForLoop} from '@/lib/loops/native-executor';
function fixtures():BrainMemory[]{return ['workshop','work'].map((type,i)=>({
  id:`own-${type}`,userId:'owner',scope:type==='workshop'?{type:'workshop',workshopId:'work-a'}:{type:'work',workId:'work-a'},
  ownerType:'work',ownerId:'work-a',memoryType:'boundary',subject:`risk-${type}`,content:i===0?'Never send externally.':'Never place real orders.',status:'verified',confidence:90,evidenceRefs:[`event-${type}`],createdAt:'2026-09-10T00:00:00Z',updatedAt:'2026-09-10T00:00:00Z',
}));}
const loop={id:'loop-a',userId:'owner',workshopId:'work-a',name:'Risk review',goal:'risk boundary',actionPolicy:{},approvalPolicy:{}} as any;
beforeEach(()=>{state.request=null;state.pack=null;state.plan=null;});
describe('native Loop Brain recall ownership',()=>{
  it('loads parent memory from both persisted scope forms through the real prompt caller',async()=>{
    const result=await loadWorkshopContextForLoop({userId:'owner',loop});
    expect(state.pack.denied).toEqual([]);
    expect(state.pack.items.map((x:any)=>x.id).sort(),JSON.stringify({plan:state.plan,omitted:state.pack.omitted})).toEqual(['own-work','own-workshop']);
    expect(state.request.requester).toMatchObject({type:'loop',id:'loop-a',workId:'work-a',workshopId:'work-a'});
    expect(result?.promptContext.memoryRecall?.backend).toBe('brain');
  });
  it('still denies other work, other users and expired memory',async()=>{
    await loadWorkshopContextForLoop({userId:'owner',loop});
    const base=fixtures()[0];
    const pack=buildBrainContextPack({requester:state.request.requester as BrainRequester,taskIntent:'risk',now:new Date('2026-09-11T00:00:00Z'),memories:[
      {...base,id:'foreign-work',ownerId:'work-b',scope:{type:'workshop',workshopId:'work-b'}},
      {...base,id:'foreign-user',userId:'other'},
      {...base,id:'expired',expiresAt:'2026-09-10T00:00:00Z'},
    ]});
    expect(pack.items).toEqual([]);
    expect(pack.denied).toEqual(expect.arrayContaining([{id:'foreign-work',reason:'no_matching_grant'},{id:'foreign-user',reason:'wrong_user'},{id:'expired',reason:'expired'}]));
  });
  it('does not resolve a parent belonging to another user',async()=>{
    await expect(loadWorkshopContextForLoop({userId:'other',loop})).rejects.toThrow('Workshop not found');
    expect(state.request).toBeNull();
  });
});
