import {describe,it,expect} from 'vitest';
import type {AgentMessage,AgentRuntimeTerminal} from '@openzhiyu/ai/agent/types';
import {createAnswerEvidenceCore} from '@/lib/ai/runtime/answer-evidence-core';
import {bindOwnerLoopPartialDelivery,deliverOwnerLoopPartial} from '@/lib/ai/loop-partial-delivery';
const ownerId='11111111-1111-4111-8111-111111111111',loopId='22222222-2222-4222-8222-222222222222';
const question=`Loop ${loopId} current executor and goal?`;
const context={ownerId,loopId,adapter:'native_platform_recall',toolName:'platformRecall'} as const;
const terminal:AgentRuntimeTerminal={schemaVersion:'agent-runtime-terminal.v1',status:'completed',cleanupStatus:'completed',completionScope:'runtime'};
const names=['missing-core','selected-session','wrong-owner','wrong-loop','wrong-question','missing-terminal','failed-terminal','failed-cleanup','revoked','audit-failure','no-committed-observation'] as const;
describe('Original root eleven bound-core counters in regular CI',()=>{
 it.each(names)('%s never upgrades audit-only closure to committed facts',async name=>{
  const core=createAnswerEvidenceCore({mode:'enforce',supported:true,turnId:'root-unit-'+name,project:()=>undefined,
   auditSink:async()=>{if(name==='audit-failure')throw Error('Synthetic sink failure');},authorizeFinal:async()=>name!=='revoked'});
  const bound=bindOwnerLoopPartialDelivery({selectedEvidence:name==='selected-session'?{}:undefined,currentCore:name==='missing-core'?undefined:core,
   ownerId:name==='wrong-owner'?'other-owner':ownerId,loopId:name==='wrong-loop'?'other-loop':loopId,
   originalQuestion:name==='wrong-question'?question+' changed':question,factEvidenceIds:{}});
  const observed=name==='failed-terminal'?{...terminal,status:'failed' as const}:name==='failed-cleanup'?{...terminal,cleanupStatus:'failed' as const}:terminal;
  const events:AgentMessage[]=[...(name==='missing-terminal'?[]:[{type:'runtime_terminal' as const,runtimeTerminal:observed}]),{type:'done'}];
  const visible:AgentMessage[]=[];
  for await(const event of deliverOwnerLoopPartial({context,originalQuestion:question,events,independentFacts:[],gaps:['independent_field_unread'],
   rawDraft:'UNSAFE_TEST_DRAFT',rawDraftCharacters:17,overflow:false,binding:bound.binding}))visible.push(event);
  const evidence=visible.find(event=>event.answerEvidence?.schemaVersion==='owner-loop-partial-delivery.v1')?.answerEvidence;
  expect(visible.filter(e=>e.type==='text').map(e=>e.content).join('')).not.toContain('UNSAFE_TEST_DRAFT');
  expect(evidence).toMatchObject({fullOriginalQuestionVerified:false,sdkContextCommitObserved:false,committedIndependentFacts:[],commitState:'uncommitted'});
  expect(visible.some(e=>e.type==='result')).toBe(false);
  if(name==='no-committed-observation')expect(evidence).toMatchObject({outcome:'unknown',auditState:'audit_persisted',factCommitState:'no_verified_fact_commit'});
 });
});
