import {describe,it,expect,vi} from 'vitest';
import {createPiAgentRuntime} from '@openzhiyu/ai/agent/runtime';
import {createFauxCore,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai/providers/faux';
import type {AgentOptions,AgentMessage} from '@openzhiyu/ai/agent/types';
import {createHostWorkingMemory} from '@openzhiyu/ai/agent/runtime/host-working-memory';
import {createHash} from 'node:crypto';

const question='Which source should be checked next?';
const checkpointHash='a'.repeat(64);
async function run(input:{approved?:boolean;deny?:boolean;auditFails?:boolean;budgetFails?:boolean;modelLog?:boolean;mode?:'apply'|'shadow'|'off'}={}){
 const faux=createFauxCore({}),audit=vi.fn(async(_event:unknown)=>{if(input.auditFails)throw Error('store unavailable');});
 const permission=vi.fn(async()=>input.deny?{behavior:'deny' as const,message:'Owner denied'}:{behavior:'allow' as const});
 const before=vi.fn(async()=>{if(input.budgetFails)throw Error('budget exhausted');});
 const state={facts:[],hypotheses:[],openQuestions:[question],nextAction:{text:'',evidenceIds:[]}};
 faux.setResponses([...(input.modelLog?[fauxAssistantMessage(fauxToolCall('workingMemory',{operation:'update',commandId:'model-log',expectedVersion:0,state,phase:'LOG'}),{stopReason:'toolUse'})]:[]),fauxAssistantMessage('valid ordinary report')]);
 const stream=vi.fn(async(...args:Parameters<typeof faux.streamSimple>)=>faux.streamSimple(...args));
 const runtime=createPiAgentRuntime({adapter:'harness',model:faux.getModel(),streamFn:stream,tools:[]});
 const options:AgentOptions={hostWorkingMemory:{mode:input.mode??'apply',readonlyToolNames:['Read'],onAudit:audit},
  onBeforeToolUse:before,onPermissionRequest:permission,
  hostFinalValidation:{maxCorrections:0,timeoutMs:10000,validate:async()=>input.approved===false?{ok:false,feedback:'evidence missing'}:{ok:true},
   progressFromValidatedReport:()=>({openQuestions:[question],checkpointHash})}};
 const messages:AgentMessage[]=[];for await(const m of runtime.run({operation:'run',prompt:'ordinary task',options}))messages.push(m);
 return {messages,audit,permission,before,stream,terminal:messages.find(m=>m.type==='runtime_terminal')?.runtimeTerminal};
}
describe('validated report progress commits',()=>{
 it('persists only authored questions with explicit host provenance after business approval, without a synthetic model tool call',async()=>{
  const r=await run();expect(r.terminal?.status).toBe('completed');expect(r.stream).toHaveBeenCalledTimes(1);
  expect(r.audit).toHaveBeenCalledTimes(1);expect(r.before).toHaveBeenCalledTimes(1);expect(r.permission).toHaveBeenCalledTimes(1);
  const event=r.audit.mock.calls[0][0] as any;
  expect(event).toMatchObject({phase:'LOG',version:1,commitOrigin:'validated_report_checkpoint',sourceCheckpointHash:checkpointHash,
   validatedReportHash:createHash('sha256').update('valid ordinary report').digest('hex'),state:{facts:[],hypotheses:[],openQuestions:[question],nextAction:{text:'',evidenceIds:[]}}});
  expect(r.messages.some(m=>m.type==='tool_use')).toBe(false);
 });
 it('does not commit rejected reports',async()=>{const r=await run({approved:false});expect(r.terminal?.status).toBe('failed');expect(r.audit).not.toHaveBeenCalled();expect(r.before).not.toHaveBeenCalled();});
 it.each([{deny:true},{auditFails:true},{budgetFails:true}])('withholds the approved report if host commit fails: %j',async input=>{
  const r=await run(input);expect(r.terminal?.status).toBe('failed');expect(r.messages.some(m=>m.type==='result'&&m.answerPhase==='committed')).toBe(false);
  if(input.deny||input.budgetFails)expect(r.audit).not.toHaveBeenCalled();
 });
 it('preserves a real model LOG and never relabels or duplicates it',async()=>{
  const r=await run({modelLog:true});expect(r.terminal?.status).toBe('completed');expect(r.audit).toHaveBeenCalledTimes(1);
  expect((r.audit.mock.calls[0][0] as any).commitOrigin).toBeUndefined();expect(r.before).toHaveBeenCalledTimes(1);
 });
 it.each(['off','shadow'] as const)('does not apply host commits in %s mode',async mode=>{
  const r=await run({mode});expect(r.terminal?.status).toBe('completed');expect(r.audit).not.toHaveBeenCalled();expect(r.before).not.toHaveBeenCalled();
 });
 it('keeps the previous version when the audit cannot be saved and rejects model-supplied host provenance',async()=>{
  const memory=createHostWorkingMemory({options:{mode:'apply',readonlyToolNames:['Read'],onAudit:async()=>{throw Error('store unavailable');}},signal:new AbortController().signal});
  await expect(memory.commitReportProgress({text:'report',openQuestions:[question],checkpointHash},async()=>{})).rejects.toThrow('not persisted');
  expect(memory.snapshot()).toMatchObject({version:0,logCount:0});
  const fresh=createHostWorkingMemory({options:{mode:'apply',readonlyToolNames:['Read'],onAudit:async()=>{}},signal:new AbortController().signal});
  const r=await fresh.manage({operation:'update',commandId:'forged',expectedVersion:0,phase:'LOG',commitOrigin:'validated_report_checkpoint',
   state:{facts:[],hypotheses:[],openQuestions:[question],nextAction:{text:'',evidenceIds:[]}}});expect(r.ok).toBe(false);
 });
});
