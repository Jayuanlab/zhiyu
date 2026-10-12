import {describe,it,expect} from 'vitest';import {Type} from '@earendil-works/pi-ai';
import {createFauxCore,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai/providers/faux';
import type {AgentTool} from '@earendil-works/pi-agent-core';
import type {AgentMessage} from '@openzhiyu/ai/agent/types';
import {createPiAgentRuntime} from '@openzhiyu/ai/agent/runtime';
import {createOwnerLoopPartialHost} from '@/lib/ai/loop-partial-host';
import {wrapOwnerLoopWorkflowReaders} from '@/lib/ai/loop-partial-workflow-tools';
import {guardOwnerLoopFacetAnswer} from '@/lib/ai/loop-owner-facet-session';
import {evidenceWindow} from '@/lib/ai/evidence-window';
import type {OwnerLoopFacetSession} from '@/lib/ai/loop-owner-facet-session';
type PartialView=Record<string,unknown>&{hostCoverage?:ReturnType<OwnerLoopFacetSession['project']>};
const ownerId='11111111-1111-4111-8111-111111111111',loopId='22222222-2222-4222-8222-222222222222',runId='33333333-3333-4333-8333-333333333333';
const context={ownerId,loopId,adapter:'owner_workflow_runtime_reader',toolName:'readLoopRuntimeObservation'} as const;
const question=`Loop ${loopId} last failure fixed and current executor? Also report unknown failure count.`;
const at='2026-10-04T00:00:00.000Z';
const run=JSON.stringify({source:'loopRuns',id:runId,fields:{id:runId,loopId,status:'failed',createdAt:at,error:'synthetic observed failure',
 verificationResult:{inputVersion:'v1',target:'artifact',expectedHash:'a'.repeat(64),observedHash:'b'.repeat(64),passed:false}}});
const page={...evidenceWindow(run),source:'loopRuns',id:runId};
async function execute(commit=true,selectedEvidence:unknown=null){
 const host=createOwnerLoopPartialHost({selectedEvidence,context,originalQuestion:question,turnId:'workflow-offline',runtimeHash:'installed-offline-harness',
  policyHash:'registered-owner-readers',toolNames:['readLoopRunTimeline','readRunRecord','readLoopRuntimeObservation'],auditSink:async()=>{},authorizeFinal:async()=>true});
 if(!host)return {host,visible:[] as AgentMessage[],evidence:undefined,text:'',sdkEntries:0};
 const outputs:Record<string,unknown>={readLoopRunTimeline:{status:'read',loopId,afterRunId:runId,cursorRunId:null,
  baseline:{id:runId,status:'failed',createdAt:at},ordering:'createdAt_asc_id_asc',runs:[],coverage:{hasMore:false,nextCursorRunId:null}},
  readRunRecord:page,readLoopRuntimeObservation:{provider:'workshop_execution_leases',ownerId,loopId,observedAt:at,
   status:'no_active_linked_execution_observed',observationScope:'active_linked_execution_mapping_only',linkedExecution:null}};
 const original:AgentTool[]=Object.keys(outputs).map(name=>({name,label:name,description:'Synthetic owner fixture reader',parameters:Type.Object({}),
  execute:async()=>({content:[{type:'text',text:JSON.stringify(outputs[name])}],details:{existingFixture:'unchanged'}})}));
 const unrelated:AgentTool={name:'pauseLoop',label:'pauseLoop',description:'Never called in this offline test',parameters:Type.Object({}),execute:async()=>{throw Error('Unrelated action must not execute');}};
 const wrapped=wrapOwnerLoopWorkflowReaders([...original,unrelated],()=>host);expect(wrapped.at(-1)).toBe(unrelated);
 const faux=createFauxCore({});faux.setResponses([
  fauxAssistantMessage(fauxToolCall('readLoopRunTimeline',{loopId,afterRunId:runId}),{stopReason:'toolUse'}),
  fauxAssistantMessage(fauxToolCall('readRunRecord',{runId,offset:0}),{stopReason:'toolUse'}),
  fauxAssistantMessage(fauxToolCall('readLoopRuntimeObservation',{loopId}),{stopReason:'toolUse'}),
  fauxAssistantMessage('UNSAFE_WORKFLOW_DRAFT: all fixed and stopped.')]);
 const runtime=createPiAgentRuntime({adapter:'harness',model:faux.getModel(),streamFn:faux.streamSimple,tools:wrapped});let sdkEntries=0;
 const raw=runtime.run({operation:'run',prompt:question,options:{onToolContextCommitted:commit?async receipt=>{sdkEntries++;await host.onToolContextCommitted(receipt);}:undefined}});
 const visible:AgentMessage[]=[];for await(const event of guardOwnerLoopFacetAnswer(raw,question,context,host.binding))visible.push(event);
 return {host,visible,evidence:visible.find(e=>e.answerEvidence?.schemaVersion==='owner-loop-partial-delivery.v1')?.answerEvidence as PartialView|undefined,
  text:visible.filter(e=>e.type==='text').map(e=>e.content).join(''),sdkEntries};
}
describe('Same shared workflow reader adapter and actual installed SDK chain',()=>{
 it('retains committed full run observation and runtime, with explicit unresolved repair and unknown ask',async()=>{
  const r=await execute();expect(r.sdkEntries).toBe(3);expect(r.host?.core.snapshot().contextReceiptCount).toBe(2);
  expect(r.evidence).toMatchObject({outcome:'partial',commitState:'committed_partial',sdkContextCommitObserved:true,runtimeFacet:{state:'observed'}});
  expect(r.evidence?.committedIndependentFacts).toEqual([expect.objectContaining({facet:'history_observation',evidenceRefs:[`loopRuns:${runId}@${page.contentHash}`]})]);
  expect(r.text).toContain(runId);expect(r.text).not.toContain('UNSAFE_WORKFLOW_DRAFT');expect(r.evidence?.gaps).toContain('unknown_independent_question_obligations');
  expect(r.evidence?.hostCoverage?.repairCoverage?.latestFailureHasMatchingVerifiedSuccessor).toBe(false);
 });
 it('the same constructed workflow reads without installed SDK callback remain unknown',async()=>{
  const r=await execute(false);expect(r.host?.core.snapshot().receiptCount).toBe(2);expect(r.sdkEntries).toBe(0);
  expect(r.evidence).toMatchObject({outcome:'unknown',commitState:'uncommitted',committedIndependentFacts:[]});expect(r.text).not.toContain(runId);
  expect(r.visible.some(e=>e.type==='result')).toBe(false);
 });
 it('an existing selected session prevents any competing workflow host/core or SDK launch',async()=>{
  const r=await execute(true,{kind:'exact-loop'});expect(r.host).toBeUndefined();expect(r.sdkEntries).toBe(0);expect(r.visible).toEqual([]);
 });
});
