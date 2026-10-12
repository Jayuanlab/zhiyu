import {describe,it,expect,vi} from 'vitest';
import {Type} from '@earendil-works/pi-ai';
import {createGuardedPiTool} from '@/lib/ai/runtime/pi-tool-adapter';
import {createMemoryReadBudget} from '@/lib/ai/memory-read-budget';
import {createMemoryAccessTool} from '@/lib/ai/memory-access';
import {reducePlatformRecordReadResult} from '@/lib/ai/serialized-record-window';
const id='70000000-0000-4000-8000-000000000001',hash='a'.repeat(64),handle='pfr_'+'b'.repeat(32);
const schema=Type.Object({recordRead:Type.Object({source:Type.Unsafe<string>({type:'string',enum:['message']}),id:Type.String(),offset:Type.Optional(Type.Integer())})});
function fixture(offset=0,oversize=false){
 const content=('"\\😀abc'.repeat(1300)).slice(0,8000);
 const texts=Array.from({length:13},(_,index)=>({index:index*2+1,type:'text',textIndex:index,text:'Known section '+index+' '+('"\\😀'.repeat(28)),textStatus:'complete'}));
 const recordRead={status:'read',source:'message',id,offset,nextOffset:offset+content.length,totalCharacters:offset+content.length+20000,truncated:true,content,contentHash:hash,
  messageStructure:{partCount:26,knownTextPartsComplete:true,rawRecordComplete:false,parts:texts},
  publishedFacts:{role:'assistant',chatId:'70000000-0000-4000-8000-000000000002',rawRecordComplete:false},
  readHandles:[{readHandle:handle,source:'message',id,fieldKey:'textParts',parentContentHash:hash}],
  provenance:{provider:'synthetic_owner_capture',sourceHash:hash,detail:'p'.repeat(oversize?30000:4800)}};
 return {ok:true,isError:false,recordRead,fieldRead:{source:'chat',id:'70000000-0000-4000-8000-000000000002',fields:[{fieldKey:'title',value:'Historical "title" \\ 😀',complete:true}]},completionGate:{status:'record_read_continuation_required',nextRead:{source:'message',id,offset:recordRead.nextOffset,expectedHash:hash}}};
}
const format=(result:any)=>{const {data:_data,text:_text,...wire}=result;return JSON.stringify(wire)};
function setup(shape:'native_text'|'single_page',offset=0,oversize=false,withGaps=false){
 const packet:any=fixture(offset,oversize);if(withGaps)packet.unavailable=[{source:'synthetic_auxiliary',reason:'Original source warning "quoted" \\ 😀',scope:'unread_auxiliary'}];
 const constructed:any[]=[],budget=createMemoryReadBudget(),handler=vi.fn(async(_params:any,context:any)=>{
  const result=shape==='native_text'?{...packet,text:JSON.stringify(packet),data:{recordRead:packet.recordRead,fieldRead:packet.fieldRead}}:{...packet,data:{recordRead:packet.recordRead,fieldRead:packet.fieldRead}};
  return (reducePlatformRecordReadResult as any)(result,shape,{fitsModelText:context.fitsModelText,maximumCharacters:24000});
 });
 const definition={name:'platformRecall',description:'Synthetic owner read',parameters:schema,policy:{allowedTools:['platformRecall'],deniedTools:[],defaultDecision:'deny' as const},execute:handler,formatResult:shape==='native_text'?(r:any)=>r.text:format,onResultConstructed:(r:any)=>{constructed.push(r)}};
 const tool=createGuardedPiTool(budget.wrap([definition])[0]);
 const gateway=createMemoryAccessTool({tools:[tool],identity:{kind:'chat'},originalQuestion:'message '+id});
 return {packet,constructed,budget,handler,tool,gateway};
}
const request=(offset=0)=>({question:'Read this synthetic historical message.',domains:['platform'],reads:[{kind:'platform_record',source:'message',id,offset}]});
const body=(result:any)=>JSON.parse(result.content[0].text);
describe('source-bound message packet fitting before guarded construction',()=>{
 it.each(['native_text','single_page'] as const)('keeps complete metadata over 8k and shrinks only a partial raw prefix (%s)',async shape=>{
  const s=setup(shape),result=await s.gateway.execute('outer',request()),outer=body(result),observation=outer.observations[0];
  expect(result.content[0]).toMatchObject({type:'text'});expect((result.content[0] as any).text.length).toBeLessThanOrEqual(24000);
  expect(observation).toMatchObject({status:'retrieved',truncated:false});expect(observation.evidence.length).toBeGreaterThan(8000);
  const wire=JSON.parse(observation.evidence),page=wire.recordRead;
  expect(page.content.length).toBeGreaterThan(0);expect(page.content.length).toBeLessThan(8000);
  expect(page.nextOffset).toBe(page.content.length);expect(wire.completionGate.nextRead).toEqual({source:'message',id,offset:page.nextOffset,expectedHash:hash});
  for(const key of ['messageStructure','publishedFacts','readHandles','provenance'])expect(page[key]).toEqual((s.packet.recordRead as any)[key]);
  expect(wire.fieldRead).toEqual(s.packet.fieldRead);expect(s.constructed).toHaveLength(1);expect(s.constructed[0].modelText).toBe(observation.evidence);
  expect((result.details as any).delegatedReceipts[0]).toMatchObject({deliveredComplete:true,modelText:observation.evidence});expect(s.handler).toHaveBeenCalledTimes(1);
  expect(s.budget.snapshot()).toMatchObject({attempts:1,withheldResults:0});
 });
 it('preserves absolute nonzero offsets and does not split a surrogate pair',async()=>{
  const s=setup('single_page',301),result=await s.gateway.execute('outer',request(301)),wire=JSON.parse(body(result).observations[0].evidence),page=wire.recordRead;
  expect(page.nextOffset).toBe(301+page.content.length);expect(wire.completionGate.nextRead.offset).toBe(page.nextOffset);
  const last=page.content.charCodeAt(page.content.length-1);expect(last>=0xd800&&last<=0xdbff).toBe(false);expect(page.contentHash).toBe(hash);
 });
 it('does not construct successful fact receipts when mandatory metadata alone cannot fit',async()=>{
  const s=setup('single_page',0,true),result=await s.gateway.execute('outer',request()),observation=body(result).observations[0];
  expect(observation).toMatchObject({status:'unavailable'});expect(observation.reason).toContain('metadata_exceeds');expect(observation).not.toHaveProperty('nextRead');
  expect(s.constructed).toEqual([]);expect((result.details as any).delegatedReceipts).toEqual([]);expect(s.handler).toHaveBeenCalledTimes(1);
 });
 it('preserves already projected observations with four reads and gaps later packets that cannot fit',async()=>{
  const s=setup('single_page'),r=request();r.reads=[0,1,2,3].map(offset=>({kind:'platform_record',source:'message',id,offset}));
  const result=await s.gateway.execute('outer',r),outer=body(result),delivered=(result.details as any).delegatedReceipts.filter((r:any)=>r.deliveredComplete);
  expect((result.content[0] as any).text.length).toBeLessThanOrEqual(24000);expect(outer.observations).toHaveLength(4);
  expect(outer.observations[0]).toMatchObject({status:'retrieved',truncated:false});expect(delivered).toHaveLength(1);
  expect(delivered[0].modelText).toBe(outer.observations[0].evidence);expect(s.constructed).toHaveLength(1);
  expect(outer.observations.slice(1).every((o:any)=>o.status==='unavailable'&&o.reason.includes('metadata_exceeds'))).toBe(true);
 });
 it('keeps the host fitting callback out of public parameters and preserves direct execution',async()=>{
  const s=setup('single_page');expect(JSON.stringify(s.tool.parameters)).not.toContain('fitsModelText');
  expect(typeof (s.tool as any).executeForEnvelope).toBe('function');
  const direct=await s.tool.execute('direct',{recordRead:{source:'message',id}});expect(JSON.parse((direct.content[0] as any).text).recordRead.content).toBe(s.packet.recordRead.content);
  expect(s.handler.mock.calls[0][1].fitsModelText).toBeUndefined();
 });
 it('calls the current execute wrapper and isolates concurrent host callbacks from direct execution',async()=>{
  let release!:()=>void;const pending=new Promise<void>(resolve=>{release=resolve}),seen:any[]=[],fitA=vi.fn((text:string)=>text==='A'),fitB=vi.fn((text:string)=>text==='B');
  const tool=createGuardedPiTool({name:'platformRecall',description:'Synthetic asynchronous guard',parameters:Type.Object({value:Type.String()}),policy:{allowedTools:['platformRecall'],deniedTools:[],defaultDecision:'deny'},execute:async(params,context)=>{seen.push({value:params.value,fit:context.fitsModelText,keys:Object.keys(params)});await pending;return params.value},formatResult:r=>r});
  const original=tool.execute.bind(tool),wrapper=vi.fn((...args:Parameters<typeof tool.execute>)=>original(...args));tool.execute=wrapper;
  const a=tool.executeForEnvelope('a',{value:'A'},fitA),b=tool.executeForEnvelope('b',{value:'B'},fitB),direct=tool.execute('direct',{value:'D'});
  release();await Promise.all([a,b,direct]);
  expect(wrapper).toHaveBeenCalledTimes(3);expect(seen.find(v=>v.value==='A').fit).toBe(fitA);expect(seen.find(v=>v.value==='B').fit).toBe(fitB);expect(seen.find(v=>v.value==='D').fit).toBeUndefined();
  expect(seen.every(v=>JSON.stringify(v.keys)==='["value"]')).toBe(true);expect(fitA.mock.calls.every(([text])=>text==='A')).toBe(true);expect(fitB.mock.calls.every(([text])=>text==='B')).toBe(true);
  await tool.execute('after',{value:'E'});expect(seen.find(v=>v.value==='E').fit).toBeUndefined();expect(JSON.stringify(tool.parameters)).not.toContain('fitsModelText');
 });
 it('clears the host callback after an exceptional asynchronous call',async()=>{
  const seen:any[]=[],fit=vi.fn(()=>true),tool=createGuardedPiTool({name:'platformRecall',description:'Synthetic failure',parameters:Type.Object({fail:Type.Boolean()}),policy:{allowedTools:['platformRecall'],deniedTools:[],defaultDecision:'deny'},execute:async(params,context)=>{await Promise.resolve();seen.push(context.fitsModelText);if(params.fail)throw Error('synthetic async failure');return 'ok'},formatResult:r=>r});
  await expect(tool.executeForEnvelope('failure',{fail:true},fit)).rejects.toThrow('synthetic async failure');await tool.execute('after',{fail:false});
  expect(seen).toEqual([fit,undefined]);
 });
 it('fits using the same complete source-gap metadata as the final observation',async()=>{
  const s=setup('single_page',0,false,true),result=await s.gateway.execute('outer',request()),observation=body(result).observations[0],wire=JSON.parse(observation.evidence);
  expect(observation.sourceGaps).toEqual(s.packet.unavailable);expect(wire.unavailable).toEqual(s.packet.unavailable);expect(observation.truncated).toBe(false);
  expect((result.content[0] as any).text.length).toBeLessThanOrEqual(24000);expect((result.details as any).delegatedReceipts[0].deliveredComplete).toBe(true);
 });
 it('retains the first fitted packet when a later huge exception and self inventory require gaps',async()=>{
  const s=setup('single_page'),other={name:'searchUnifiedMemory',label:'Synthetic',description:'large self inventory '+('"\\😀'.repeat(15000)),parameters:Type.Object({}),execute:vi.fn(async()=>{throw Error('synthetic large reason '+('"\\😀'.repeat(15000)))})};
  const gateway=createMemoryAccessTool({tools:[s.tool,other],identity:{kind:'chat'},originalQuestion:'message '+id}),r=request();r.domains=['platform','memory','self'];
  const result=await gateway.execute('outer',r),outer=body(result);
  expect((result.content[0] as any).text.length).toBeLessThanOrEqual(24000);expect(outer).not.toHaveProperty('questionReadState');expect(outer.observations).toHaveLength(3);
  expect(outer.observations[0]).toMatchObject({status:'retrieved',truncated:false});expect((result.details as any).delegatedReceipts[0]).toMatchObject({deliveredComplete:true,modelText:outer.observations[0].evidence});
  expect(s.constructed[0].modelText).toBe(outer.observations[0].evidence);expect(outer.observations.slice(1).every((o:any)=>o.reason==='memory_access_output_over_budget')).toBe(true);
 });
});
