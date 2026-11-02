import{describe,it,expect,vi}from'vitest';
import{z}from'zod';
import{tool,createToolServer}from'@/lib/ai/tools/definitions';
import{adaptRuntimeToolDefinition,guardPiTools,inProcessServerTools}from'@/lib/ai/tools/pi-tools';
import{preparePiImages}from'../../../../packages/ai/src/agent/runtime/pi-images';
import{inspectPiRetirement}from'../../scripts/check-pi-retirement-readiness.mjs';
describe('host-owned Pi tool contracts',()=>{
 it('preserves the business handler and validates arguments before execution',async()=>{
  const handler=vi.fn(async({id}:{id:string})=>({content:[{type:'text' as const,text:id}]}));
  const definition=tool('readFact','Read a fact',{id:z.string()},handler),adapted=adaptRuntimeToolDefinition(definition);
  await expect(adapted.execute('invalid',{id:42})).rejects.toThrow();expect(handler).not.toHaveBeenCalled();
  expect(await adapted.execute('valid',{id:'owner-fact'})).toMatchObject({content:[{type:'text',text:'owner-fact'}]});
  expect(handler).toHaveBeenCalledWith({id:'owner-fact'},expect.objectContaining({toolCallId:'valid'}));
 });
 it('does not turn error tool results into success',async()=>{const adapted=adaptRuntimeToolDefinition(tool('fail','Fail',{},async()=>({isError:true,content:[{type:'text',text:'failed'}]})));await expect(adapted.execute('id',{})).rejects.toThrow('failed');});
 it('rejects duplicates and retired process-backed server records',()=>{const definition=tool('readFact','Read',{},async()=>({content:[]}));expect(()=>createToolServer({name:'test',version:'1',tools:[definition,definition]})).toThrow('duplicate_host_tool');expect(()=>inProcessServerTools({old:{type:'sdk',instance:{}}})).toThrow('host_tool_server_invalid');expect(inProcessServerTools({current:createToolServer({name:'test',version:'1',tools:[definition]})}).map(t=>t.name)).toEqual(['readFact']);});
 it('denied wins over allowed and approval is never silently bypassed',async()=>{const execute=vi.fn(async()=>({content:[],details:{}}));const base={name:'write',label:'write',description:'Write',parameters:{} as any,execute};for(const policy of [{allowedTools:['write'],deniedTools:['write']},{allowedTools:['write'],requiresApprovalTools:['write']},{allowedTools:[]}]){const guarded=guardPiTools([base],policy)[0];await expect(guarded.execute('id',{})).rejects.toThrow();}expect(execute).not.toHaveBeenCalled();});
 it('does not dispatch a cancelled tool',async()=>{const handler=vi.fn(async()=>({content:[]}));const adapted=adaptRuntimeToolDefinition(tool('readFact','Read',{},handler));await expect(adapted.execute('id',{},AbortSignal.abort())).rejects.toThrow();expect(handler).not.toHaveBeenCalled();});
 it('accepts explicit image bytes and rejects implicit remote or host sources',()=>{expect(preparePiImages([{data:'aGVsbG8=',mimeType:'image/png'}])).toEqual([{type:'image',data:'aGVsbG8=',mimeType:'image/png'}]);for(const image of [{url:'https://private.invalid',mimeType:'image/png'},{data:'C:/private.png',mimeType:'image/png'},{data:'aGVsbG8=',mimeType:'text/plain'}])expect(()=>preparePiImages([image])).toThrow('pi_image_source_invalid');});
});
describe('Pi retirement guard',()=>{
 it('fails on active dependency or execution imports and permits Anthropic model transport',()=>{const sources:Record<string,string>={'apps/web/package.json':'{"dependencies":{"@anthropic-ai/claude-agent-sdk":"1"}}','apps/web/lib/run.ts':'import {query} from "@anthropic-ai/claude-agent-sdk";','packages/ai/src/provider.ts':'import {streamSimple} from "@earendil-works/pi-ai/api/anthropic-messages";'};const result=inspectPiRetirement(Object.keys(sources),file=>sources[file]);expect(result.passed).toBe(false);expect(result.violations).toHaveLength(2);});
 it('retains historical labels without treating their type as a current engine',()=>{const sources:Record<string,string>={'apps/web/lib/history.ts':'interface History { engine: "claude" | "pi" }','apps/web/lib/current.ts':'const selection={engine:"pi"};'};expect(inspectPiRetirement(Object.keys(sources),file=>sources[file]).passed).toBe(true);});
});
