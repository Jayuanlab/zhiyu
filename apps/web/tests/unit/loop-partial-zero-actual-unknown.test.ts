import {describe,it,expect} from 'vitest';
import type {AgentMessage} from '@openzhiyu/ai/agent/types';
import {createAnswerEvidenceCore} from '@/lib/ai/runtime/answer-evidence-core';
import {bindOwnerLoopPartialDelivery,deliverOwnerLoopPartial} from '@/lib/ai/loop-partial-delivery';

const ownerId='11111111-1111-4111-8111-111111111111',loopId='22222222-2222-4222-8222-222222222222';
const question=`Loop ${loopId} current executor and goal?`;
const context={ownerId,loopId,adapter:'native_platform_recall',toolName:'platformRecall'} as const;
const cases=['missing-core','selected-session','wrong-owner','wrong-loop','wrong-question'] as const;

describe('Zero actual facts remain unknown across missing or mismatched host bindings',()=>{
 for(const name of cases)it(name,async()=>{
  const core=createAnswerEvidenceCore({mode:'owner_partial',supported:true,turnId:`independent-${name}`,
   project:()=>undefined,auditSink:async()=>{},authorizeFinal:async()=>true});
  const bound=bindOwnerLoopPartialDelivery({selectedEvidence:name==='selected-session'?{kind:'existing-session'}:null,
   currentCore:name==='missing-core'?undefined:core,ownerId:name==='wrong-owner'?'other-owner':ownerId,
   loopId:name==='wrong-loop'?'other-loop':loopId,originalQuestion:name==='wrong-question'?question+' changed':question,factEvidenceIds:{}});
  const events:AgentMessage[]=[{type:'runtime_terminal',runtimeTerminal:{schemaVersion:'agent-runtime-terminal.v1',
   status:'completed',cleanupStatus:'completed',completionScope:'runtime'}},{type:'done'}];
  const visible:AgentMessage[]=[];
  for await(const event of deliverOwnerLoopPartial({context,originalQuestion:question,events,independentFacts:[],
   gaps:['independent_field_unread'],rawDraft:'UNSAFE_ZERO_FACT_DRAFT',rawDraftCharacters:22,overflow:false,binding:bound.binding}))visible.push(event);
  const evidence=visible.find(e=>e.answerEvidence?.schemaVersion==='owner-loop-partial-delivery.v1')?.answerEvidence;
  const text=visible.filter(e=>e.type==='text').map(e=>e.content??'').join('');
  // These safety properties already hold; unknown is the missing state contract, not relaxed delivery.
  expect(evidence?.sdkContextCommitObserved).toBe(false);
  expect(evidence?.committedIndependentFacts).toEqual([]);
  expect(evidence?.commitState).toBe('uncommitted');
  expect(evidence?.fullOriginalQuestionVerified).toBe(false);
  expect(visible.some(e=>e.type==='result')).toBe(false);
  expect(text).not.toContain('UNSAFE_ZERO_FACT_DRAFT');
  expect(text).toContain('当前执行状态仍未知');
  expect(evidence?.outcome).toBe('unknown');
 });
});
