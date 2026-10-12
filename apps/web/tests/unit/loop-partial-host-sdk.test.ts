import {describe,it,expect} from 'vitest';
import {Type} from '@earendil-works/pi-ai';
import {createFauxCore,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai/providers/faux';
import {createPiAgentRuntime} from '@openzhiyu/ai/agent/runtime';
import type {AgentMessage,AgentRuntimeTerminal} from '@openzhiyu/ai/agent/types';
import {createGuardedPiTool} from '@/lib/ai/runtime/pi-tool-adapter';
import {canCreateOwnerLoopPartialHost,createOwnerLoopPartialHost} from '@/lib/ai/loop-partial-host';
import {guardOwnerLoopFacetAnswer} from '@/lib/ai/loop-owner-facet-session';
import {evidenceWindow} from '@/lib/ai/evidence-window';
import {answerTextHash} from '@/lib/ai/runtime/answer-evidence-core';
import type {AnswerEvidenceAuditEvent} from '@/lib/ai/runtime/answer-evidence-contract';
import type {OwnerLoopFacetSession} from '@/lib/ai/loop-owner-facet-session';
type PartialView=Record<string,unknown>&{gaps:string[];originalQuestion:{text:string;charactersUtf16:number;sha256:string};hostCoverage?:ReturnType<OwnerLoopFacetSession['project']>};
const ownerId='11111111-1111-4111-8111-111111111111',loopId='22222222-2222-4222-8222-222222222222';
const context={ownerId,loopId,adapter:'native_platform_recall',toolName:'platformRecall'} as const;
const goal='Preserve the complete owner goal; a paused configuration is not process liveness.';
const content=JSON.stringify({source:'loops',id:loopId,fields:{id:loopId,goal}});
const page={...evidenceWindow(content),source:'loops',id:loopId};
const runtimeObservation={provider:'workshop_execution_leases',ownerId,loopId,observedAt:'2026-10-04T00:00:09.000Z',
 status:'no_active_linked_execution_observed',observationScope:'active_linked_execution_mapping_only',linkedExecution:null,
 loopConfiguration:{status:'paused',updatedAt:'2026-10-04T00:00:08.000Z'}};
const question=`Loop ${loopId} goal and current executor? Also report the unknown failure count.`;
type Scenario={reads?:Array<'goal'|'runtime'|'discovery'>;construct?:boolean;commit?:boolean;audit?:boolean;
 authorize?:boolean;denied?:boolean;terminal?:Partial<AgentRuntimeTerminal>;wrongOwner?:boolean;question?:string;
 pagedGoal?:boolean;omitPageCommit?:number;wrongGoalFieldId?:boolean};
async function execute(s:Scenario={}) {
 const audit:AnswerEvidenceAuditEvent[]=[],callbacks:{toolCallId:string;entryId:string;modelText:string}[]=[];
 const originalQuestion=s.question??question;
 const host=createOwnerLoopPartialHost({selectedEvidence:null,context,originalQuestion,turnId:'offline-sdk-turn',
  runtimeHash:'actual-offline-harness-runtime',policyHash:'exact-owner-read-only-policy',toolNames:['platformRecall'],
  auditSink:s.audit===false?undefined:async event=>{audit.push(event);},authorizeFinal:async()=>s.authorize!==false});
 expect(host).toBeDefined();if(!host)throw Error('fixture host missing');
 const tool=createGuardedPiTool({name:'platformRecall',description:'Offline owner record/runtime reads only.',parameters:Type.Object({kind:Type.String(),
   recordRead:Type.Optional(Type.Object({source:Type.String(),id:Type.String(),offset:Type.Number(),expectedHash:Type.Optional(Type.String())})),runtimeRead:Type.Optional(Type.Object({loopId:Type.String()}))}),
  policy:{allowedTools:['platformRecall'],deniedTools:s.denied?['platformRecall']:[],defaultDecision:'deny'},
  execute:async params=>({ok:true,data:params.kind==='goal'?{recordRead:s.pagedGoal||s.wrongGoalFieldId?
   {...evidenceWindow(JSON.stringify({source:'loops',id:loopId,fields:{id:s.wrongGoalFieldId?'33333333-3333-4333-8333-333333333333':loopId,goal,...(s.pagedGoal?{description:'x'.repeat(9000)}:{})}}),params.recordRead?.offset??0),source:'loops',id:loopId}:page}:params.kind==='runtime'?
   {runtimeObservation:s.wrongOwner?{...runtimeObservation,ownerId:'33333333-3333-4333-8333-333333333333'}:runtimeObservation}:{registry:[{source:'loops',count:999}]}}),
  formatResult:result=>JSON.stringify(result),onResultConstructed:s.construct===false?undefined:host.onResultConstructed});
 const faux=createFauxCore({});
 const reads=s.reads??['goal','runtime'];
 faux.setResponses([...reads.flatMap(kind=>(kind==='goal'&&s.pagedGoal?[0,8000]:[0]).map(offset=>fauxAssistantMessage(fauxToolCall('platformRecall',{kind,
  ...(kind==='goal'?{recordRead:{source:'loops',id:loopId,offset}}:kind==='runtime'?{runtimeRead:{loopId}}:{})}),{stopReason:'toolUse'}))),
  fauxAssistantMessage('UNSAFE_DRAFT: stopped; all question items completed.')]);
 const runtime=createPiAgentRuntime({adapter:'harness',model:faux.getModel(),streamFn:faux.streamSimple,tools:[tool]});
  const actual=runtime.run({operation:'run',prompt:originalQuestion,options:{onToolContextCommitted:s.commit===false?undefined:async receipt=>{
  callbacks.push(receipt);const delivered=JSON.parse(receipt.modelText) as {data?:{recordRead?:{offset?:number}}};
  if(s.omitPageCommit!==undefined&&delivered.data?.recordRead?.offset===s.omitPageCommit)return;
  await host.onToolContextCommitted(receipt);}}});
 async function* source():AsyncGenerator<AgentMessage>{for await(const event of actual)yield event.type==='runtime_terminal'&&s.terminal
  ? {...event,runtimeTerminal:{...event.runtimeTerminal!,...s.terminal}}:event;}
 const visible:AgentMessage[]=[];for await(const event of guardOwnerLoopFacetAnswer(source(),originalQuestion,context,host.binding))visible.push(event);
 const evidence=visible.find(e=>e.answerEvidence?.schemaVersion==='owner-loop-partial-delivery.v1')?.answerEvidence as PartialView|undefined;
 const text=visible.filter(e=>e.type==='text').map(e=>e.content??'').join('');
 expect(text).not.toContain('UNSAFE_DRAFT');expect(evidence?.originalQuestion).toMatchObject({text:originalQuestion,
  charactersUtf16:originalQuestion.length,sha256:answerTextHash(JSON.stringify(originalQuestion))});
 expect(evidence?.fullOriginalQuestionVerified).toBe(false);
 return {host,visible,evidence,text,audit,callbacks};
}
describe('Authenticated partial host: actual installed offline SDK receipt chain',()=>{
 it('keeps complete goal refs and bounded runtime after real SDK entries, with unknown independent obligation gap',async()=>{
  const r=await execute();expect(r.callbacks).toHaveLength(2);expect(r.host.core.snapshot().contextReceiptCount).toBe(2);
  expect(r.evidence).toMatchObject({outcome:'partial',commitState:'committed_partial',auditState:'audit_persisted',factCommitState:'verified_partial_facts_committed',sdkContextCommitObserved:true});
  expect(r.evidence?.committedIndependentFacts).toEqual([expect.objectContaining({facet:'configuration_postcondition',evidenceRefs:[`loops:${loopId}@${page.contentHash}`]})]);
  expect(r.text).toContain(JSON.stringify(goal));expect(r.evidence?.gaps).toContain('unknown_independent_question_obligations');
  expect(r.evidence?.runtimeFacet).toMatchObject({state:'observed',mapping:'no_active_linked_mapping_observed',currentProcessActivity:'unknown',lease:{evaluated:false}});
  const receiptIds=r.host.core.contextReceiptsForClosure().map(receipt=>receipt.evidenceId);
  expect(receiptIds).toHaveLength(2);expect(new Set(receiptIds).size).toBe(2);
  expect(r.audit.filter(e=>e.eventType==='context_committed')).toHaveLength(2);
  expect(r.audit.at(-1)?.eventType).toBe('turn_completed');
 });
 it('construction and streamed result without SDK callback remain unknown and uncommitted',async()=>{
  const r=await execute({commit:false});expect(r.callbacks).toHaveLength(0);expect(r.host.core.snapshot().receiptCount).toBe(2);
  expect(r.evidence).toMatchObject({outcome:'unknown',commitState:'uncommitted',auditState:'audit_persisted',committedIndependentFacts:[],sdkContextCommitObserved:false});
  expect(r.text).toContain('当前状态仍未知');expect(r.visible.some(e=>e.type==='result')).toBe(false);
 });
 it('SDK entries without host construction do not manufacture a receipt',async()=>{
  const r=await execute({construct:false});expect(r.callbacks).toHaveLength(2);expect(r.host.core.snapshot().contextReceiptCount).toBe(0);
  expect(r.evidence).toMatchObject({outcome:'unknown',commitState:'uncommitted',committedIndependentFacts:[]});
 });
 it('retains SDK-committed runtime when the independent goal is unread',async()=>{
  const r=await execute({reads:['runtime'],question:`Loop ${loopId} goal and current executor?`});
  expect(r.evidence).toMatchObject({outcome:'partial',commitState:'committed_partial',committedIndependentFacts:[],runtimeFacet:{state:'observed'}});
  expect(r.evidence?.gaps).toContain('selected_independent_coverage_incomplete');expect(r.text).not.toContain(goal);
 });
 it('retains complete committed goal when current runtime observation is missing',async()=>{
  const r=await execute({reads:['goal']});expect(r.evidence).toMatchObject({outcome:'partial',commitState:'committed_partial',runtimeFacet:{state:'unknown'}});
  expect(r.text).toContain(JSON.stringify(goal));expect(r.evidence?.gaps).toContain('runtime_context_or_observation_unverified');
 });
 it('discovery/population metadata never supplies a record fact or resolves independent asks',async()=>{
  const r=await execute({reads:['discovery']});expect(r.host.core.snapshot().contextReceiptCount).toBe(0);
  expect(r.evidence).toMatchObject({outcome:'unknown',commitState:'uncommitted',committedIndependentFacts:[]});expect(r.text).not.toContain('999');
 });
 it('missing audit cannot promote SDK facts to a displayed committed result',async()=>{
  const r=await execute({audit:false});expect(r.host.core.snapshot().contextReceiptCount).toBe(2);
  expect(r.evidence).toMatchObject({outcome:'unknown',commitState:'uncommitted',auditIncomplete:true,committedIndependentFacts:[]});
  expect(r.evidence).toMatchObject({sdkContextCommitObserved:true,sdkContextReceiptCount:2,finalFactCommitAccepted:false});
  expect(r.visible.some(e=>e.type==='result')).toBe(false);expect(r.text).not.toContain(goal);
 });
 it('final owner authorization revocation clears both goal and runtime facts',async()=>{
  const r=await execute({authorize:false});expect(r.callbacks).toHaveLength(2);
  expect(r.evidence).toMatchObject({outcome:'unknown',commitState:'uncommitted',committedIndependentFacts:[],runtimeFacet:{state:'unknown'}});
  expect(r.evidence).toMatchObject({sdkContextCommitObserved:true,sdkContextReceiptCount:2,finalFactCommitAccepted:false});
  expect(r.text).not.toContain(goal);expect(r.visible.some(e=>e.type==='result')).toBe(false);
 });
 it('denied tool takes precedence and the handler never produces construction facts',async()=>{
  const r=await execute({denied:true});expect(r.callbacks).toHaveLength(0);expect(r.host.core.snapshot().receiptCount).toBe(0);
  expect(r.evidence).toMatchObject({outcome:'unknown',commitState:'uncommitted',committedIndependentFacts:[]});
 });
 it.each([{status:'failed' as const},{cleanupStatus:'failed' as const}])('actual failed terminal/cleanup prevents fact delivery: %o',async terminal=>{
  const r=await execute({terminal});expect(r.callbacks).toHaveLength(2);
  expect(r.evidence).toMatchObject({outcome:'execution_failed',commitState:'uncommitted',committedIndependentFacts:[]});expect(r.text).not.toContain(goal);
 });
 it('mismatched runtime owner is not turned into a runtime receipt',async()=>{
  const r=await execute({reads:['runtime'],wrongOwner:true});expect(r.host.core.snapshot().contextReceiptCount).toBe(0);
  expect(r.evidence).toMatchObject({outcome:'unknown',commitState:'uncommitted',runtimeFacet:{state:'unknown'}});
 });
 it('existing selected session returns no second host/core; native null permits the finite host',()=>{
  const options={context,originalQuestion:question,turnId:'turn',runtimeHash:'runtime',policyHash:'policy',toolNames:['platformRecall']};
  expect(createOwnerLoopPartialHost({...options,selectedEvidence:{kind:'platform'}})).toBeUndefined();
  expect(createOwnerLoopPartialHost({...options,selectedEvidence:null})).toBeDefined();
  expect(createOwnerLoopPartialHost({...options,selectedEvidence:undefined})).toBeDefined();
 });
 it('different/multiple Loop subjects and non-current asks retain original scope instead of creating a core',()=>{
  const options={context,selectedEvidence:null,turnId:'turn',runtimeHash:'runtime',policyHash:'policy',toolNames:['platformRecall']};
  for(const originalQuestion of [`Loop 33333333-3333-4333-8333-333333333333 goal and current executor?`,
   `Loop ${loopId} and Loop 33333333-3333-4333-8333-333333333333 goal and current executor?`,
   `Loop ${loopId} previous history and goal?`])expect(createOwnerLoopPartialHost({...options,originalQuestion})).toBeUndefined();
 });
 it('a two-page complete goal requires every real SDK page receipt, retaining exact parent ref',async()=>{
  const r=await execute({pagedGoal:true});expect(r.callbacks).toHaveLength(3);expect(r.host.core.snapshot().contextReceiptCount).toBe(3);
  expect(r.text).toContain(JSON.stringify(goal));expect(r.evidence?.committedIndependentFacts).toHaveLength(1);
  const ids=Object.values(r.host.binding.factEvidenceIds);expect(ids.some(group=>group.length===2)).toBe(true);
 });
 it('one omitted page SDK receipt cannot upgrade the assembled complete goal',async()=>{
  const r=await execute({pagedGoal:true,omitPageCommit:0});expect(r.callbacks).toHaveLength(3);expect(r.host.core.snapshot().contextReceiptCount).toBe(2);
  expect(r.evidence).toMatchObject({outcome:'partial',commitState:'committed_partial',committedIndependentFacts:[],runtimeFacet:{state:'observed'}});
  expect(r.text).not.toContain(goal);expect(r.evidence?.gaps.some((g:string)=>g.startsWith('context_commit_unverified:loops:'))).toBe(true);
 });
 it('a parent-hashed record with a foreign fields.id cannot manufacture goal facts',async()=>{
  const r=await execute({wrongGoalFieldId:true});expect(r.evidence?.committedIndependentFacts).toEqual([]);
  expect(r.text).not.toContain(goal);expect(r.evidence?.hostCoverage?.invalid).toBe('goal_exact_loop_field_unavailable');
 });
 it('the full original UTF-16 question survives SDK wiring, including distinct lone-surrogate hash',async()=>{
  const original=question+'\ud800';const r=await execute({question:original});expect(r.evidence?.originalQuestion.text).toBe(original);
  expect(r.evidence?.originalQuestion.sha256).not.toBe(answerTextHash(JSON.stringify(question+'\ud801')));
 });
 it('entry reservation and host construction use one exact predicate, including existing lease/heartbeat field vocabulary',()=>{
  for(const field of ['leaseMatchesRun','leaseUnexpired','leaseUntil','leasePhase','heartbeatAt','heartbeatAgeMs','heartbeatFresh']){
   const originalQuestion=`Loop ${loopId} goal and current ${field}? Also unknown failure count.`;
   expect(canCreateOwnerLoopPartialHost(context,originalQuestion,null)).toBe(true);
   expect(createOwnerLoopPartialHost({selectedEvidence:null,context,originalQuestion,turnId:'turn',runtimeHash:'runtime',policyHash:'policy',toolNames:['platformRecall']})).toBeDefined();
  }
  expect(canCreateOwnerLoopPartialHost(context,`Loop ${loopId} current leaseUnexpired?`,null)).toBe(false);
  expect(canCreateOwnerLoopPartialHost(context,question,{kind:'platform'})).toBe(false);
 });
 it('existing lease-field vocabulary with an unknown independent ask cannot fall back to the unsafe draft after SDK commit',async()=>{
  const r=await execute({question:`Loop ${loopId} goal and current leaseUnexpired? Also unknown failure count.`});
  expect(r.host.core.snapshot().contextReceiptCount).toBe(2);
  expect(r.evidence).toMatchObject({outcome:'partial',commitState:'committed_partial',fullOriginalQuestionVerified:false});
  expect(r.text).toContain(JSON.stringify(goal));expect(r.evidence?.gaps).toContain('unknown_independent_question_obligations');
 });
});
