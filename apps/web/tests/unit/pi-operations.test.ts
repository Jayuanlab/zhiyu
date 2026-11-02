import {describe,it,expect,vi} from 'vitest';
import {Type} from '@earendil-works/pi-ai';
import {createFauxCore,fauxAssistantMessage} from '@earendil-works/pi-ai/providers/faux';
import {createPiAgentRuntime} from '@openzhiyu/ai/agent/runtime';
async function collect(source:AsyncGenerator<any>){const messages=[];for await(const message of source)messages.push(message);return messages;}
function fixture(responses:ReturnType<typeof fauxAssistantMessage>[]){const faux=createFauxCore({});faux.setResponses(responses);const stream=vi.fn((...args:Parameters<typeof faux.streamSimple>)=>faux.streamSimple(...args));const execute=vi.fn(async()=>({content:[{type:'text' as const,text:'fixture'}],details:{}}));return {stream,execute,runtime:createPiAgentRuntime({model:faux.getModel(),streamFn:stream,tools:[{name:'write',label:'write',description:'Forbidden in planning',parameters:Type.Object({}),execute}]})};}
describe('Pi plan and approved execution',()=>{
 it('generates a real proposal with no tools; model JSON cannot grant authority or mark steps completed',async()=>{
  const test=fixture([fauxAssistantMessage(JSON.stringify({type:'plan',id:'forged',goal:'Read a current source',steps:[{id:'forged',description:'Inspect source',status:'completed'}],allowedTools:['write']}))]);
  const messages=await collect(test.runtime.run({operation:'plan',prompt:'Plan this task'}));const plan=messages.find(message=>message.type==='plan')?.plan;
  expect(test.stream).toHaveBeenCalledOnce();expect(test.stream.mock.calls[0][1].tools??[]).toHaveLength(0);expect(test.execute).not.toHaveBeenCalled();
  expect(plan).toMatchObject({goal:'Read a current source',steps:[{id:'step-1',status:'pending'}]});expect(plan.id).not.toBe('forged');expect(plan).not.toHaveProperty('allowedTools');
  expect(messages).toContainEqual(expect.objectContaining({type:'runtime_terminal',runtimeTerminal:expect.objectContaining({status:'completed',cleanupStatus:'completed'})}));
 });
 it('uses the host-supplied approved plan rather than an earlier cached proposal',async()=>{
  const test=fixture([fauxAssistantMessage('{"goal":"Old proposal","steps":[{"description":"Old step"}]}'),fauxAssistantMessage('host-plan-result')]);
  const planned=await collect(test.runtime.run({operation:'plan',prompt:'Plan'}));const old=planned.find(message=>message.type==='plan').plan;
  const approved={...old,goal:'Owner-approved current plan',steps:[{id:'approved',description:'Use current source',status:'pending' as const}]};
  const result=await collect(test.runtime.run({operation:'execute',options:{planId:old.id,plan:approved,originalPrompt:'Current request'}}));
  expect(JSON.stringify(test.stream.mock.calls[1][1])).toContain('Owner-approved current plan');expect(JSON.stringify(test.stream.mock.calls[1][1])).not.toContain('Old proposal');
  expect(result).toContainEqual(expect.objectContaining({type:'result',content:'host-plan-result'}));
 });
 it('rejects an unknown plan before dispatch',async()=>{const test=fixture([]);const messages=await collect(test.runtime.run({operation:'execute',options:{planId:'unknown',originalPrompt:'fixture'}}));expect(test.stream).not.toHaveBeenCalled();expect(messages).toContainEqual(expect.objectContaining({type:'error',message:'pi_plan_missing'}));});
 it('does not turn malformed plan output into approval',async()=>{const test=fixture([fauxAssistantMessage('{"goal":"Incomplete"}')]);const messages=await collect(test.runtime.run({operation:'plan',prompt:'Plan'}));expect(messages.some(m=>m.type==='plan')).toBe(false);expect(messages).toContainEqual(expect.objectContaining({type:'error',message:'pi_plan_response_invalid'}));});
 it('withholds a truncated plan even when its JSON looks valid',async()=>{const test=fixture([fauxAssistantMessage('{"goal":"Truncated","steps":[{"description":"step"}]}',{stopReason:'length'})]);const messages=await collect(test.runtime.run({operation:'plan',prompt:'Plan'}));expect(messages.some(m=>m.type==='plan')).toBe(false);expect(messages).toContainEqual(expect.objectContaining({type:'runtime_terminal',runtimeTerminal:expect.objectContaining({status:'failed'})}));});
 it('supports a direct answer without manufacturing a plan',async()=>{const test=fixture([fauxAssistantMessage('{"type":"direct_answer","answer":"Current answer"}')]);const messages=await collect(test.runtime.run({operation:'plan',prompt:'Simple question'}));expect(messages).toContainEqual({type:'direct_answer',content:'Current answer'});expect(messages.some(m=>m.type==='plan')).toBe(false);});
 it('does not dispatch a cancelled plan',async()=>{const test=fixture([]),abortController=new AbortController();abortController.abort();const messages=await collect(test.runtime.run({operation:'plan',prompt:'never',options:{abortController}}));expect(test.stream).not.toHaveBeenCalled();expect(messages.some(m=>m.type==='plan')).toBe(false);});
});
