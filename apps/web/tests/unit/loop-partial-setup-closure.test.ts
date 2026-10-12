import {describe,it,expect} from 'vitest';
import {closeOwnerLoopPartialSetup,createOwnerLoopPartialHost} from '@/lib/ai/loop-partial-host';
import type {AnswerEvidenceAuditEvent} from '@/lib/ai/runtime/answer-evidence-contract';
const ownerId='11111111-1111-4111-8111-111111111111',loopId='22222222-2222-4222-8222-222222222222';
describe('Owned partial audit reservation: request setup failure before actual runtime load',()=>{
 it('writes only setup failure to the already reserved owned sink; it cannot invent runtime/context/facts',async()=>{
  const events:AnswerEvidenceAuditEvent[]=[];
  expect(await closeOwnerLoopPartialSetup({streamStarted:false,reservedTurnId:'owned-turn',reservedAuditSink:async event=>{events.push(event);}})).toBe('setup_failed_audit_recorded');
  expect(events).toEqual([{eventKey:'partial_setup_failed_before_core',eventType:'turn_failed',payload:{scope:'request_setup_before_runtime_load',runtimeStarted:false,runtimeTerminalObserved:false,sdkContextCommitObserved:false,verifiedFactCommitted:false,reason:'request_setup_did_not_reach_loaded_owner_partial_core'}}]);
 });
 it('does not write without an owned reservation or after the stream was started',async()=>{
  let calls=0;const reservedAuditSink=async()=>{calls++;};
  expect(await closeOwnerLoopPartialSetup({streamStarted:false,reservedAuditSink})).toBe('skipped');
  expect(await closeOwnerLoopPartialSetup({streamStarted:true,reservedTurnId:'turn',reservedAuditSink})).toBe('skipped');expect(calls).toBe(0);
 });
 it('sink absent or rejected leaves explicit audit unconfirmed instead of claiming closure',async()=>{
  expect(await closeOwnerLoopPartialSetup({streamStarted:false,reservedTurnId:'turn'})).toBe('setup_failed_audit_unconfirmed');
  expect(await closeOwnerLoopPartialSetup({streamStarted:false,reservedTurnId:'turn',reservedAuditSink:async()=>{throw Error('synthetic failed sink');}})).toBe('setup_failed_audit_unconfirmed');
 });
 it('an already created unstarted core closes as failure once, with zero construction and SDK context receipts',async()=>{
  const events:AnswerEvidenceAuditEvent[]=[];
  const host=createOwnerLoopPartialHost({selectedEvidence:null,context:{ownerId,loopId,adapter:'native_platform_recall',toolName:'platformRecall'},originalQuestion:`Loop ${loopId} goal and current executor?`,turnId:'turn',runtimeHash:'runtime',policyHash:'policy',toolNames:['platformRecall'],auditSink:async event=>{events.push(event);},authorizeFinal:async()=>true});
  expect(host).toBeDefined();if(!host)throw Error('missing host');
  expect(await closeOwnerLoopPartialSetup({streamStarted:false,host,reservedTurnId:'turn'})).toBe('core_closed');
  expect(host.core.snapshot()).toMatchObject({closing:true,receiptCount:0,contextReceiptCount:0,auditFailed:false});
  expect(events.at(-1)?.eventType).toBe('turn_failed');expect(events.some(e=>e.eventType==='context_committed')).toBe(false);
  const count=events.length;expect(await closeOwnerLoopPartialSetup({streamStarted:false,host,reservedTurnId:'turn'})).toBe('core_closed');expect(events).toHaveLength(count);
 });
 it('an async setup throw before core creation reaches failure closure without a fabricated runtime receipt',async()=>{
  const events:AnswerEvidenceAuditEvent[]=[];let caught=false;let state:string|undefined;
  try {await Promise.resolve().then(()=>{throw Error('synthetic setup rejected before runtime load');});}
  catch {caught=true;} finally {state=await closeOwnerLoopPartialSetup({streamStarted:false,reservedTurnId:'owned-turn',reservedAuditSink:async event=>{events.push(event);}});}
  expect(caught).toBe(true);expect(state).toBe('setup_failed_audit_recorded');expect(events).toHaveLength(1);
  expect(events[0].payload).toMatchObject({runtimeStarted:false,runtimeTerminalObserved:false,sdkContextCommitObserved:false,verifiedFactCommitted:false});
 });
 it('repeated pre-core closure uses one identical fixed event key/payload for the existing audit idempotency contract',async()=>{
  const attempts:AnswerEvidenceAuditEvent[]=[];const persisted=new Map<string,AnswerEvidenceAuditEvent>();
  const reservedAuditSink=async(event:AnswerEvidenceAuditEvent)=>{attempts.push(event);const prior=persisted.get(event.eventKey);if(prior)expect(event).toEqual(prior);else persisted.set(event.eventKey,event);};
  for(let i=0;i<2;i++)expect(await closeOwnerLoopPartialSetup({streamStarted:false,reservedTurnId:'owned-turn',reservedAuditSink})).toBe('setup_failed_audit_recorded');
  expect(attempts).toHaveLength(2);expect(persisted.size).toBe(1);
 });
 it('a different core turn is not closed under the reserved turn label',async()=>{
  const events:AnswerEvidenceAuditEvent[]=[];
  const host=createOwnerLoopPartialHost({selectedEvidence:null,context:{ownerId,loopId,adapter:'native_platform_recall',toolName:'platformRecall'},originalQuestion:`Loop ${loopId} goal and current executor?`,turnId:'different-turn',runtimeHash:'runtime',policyHash:'policy',toolNames:['platformRecall'],auditSink:async event=>{events.push(event);},authorizeFinal:async()=>true});
  expect(await closeOwnerLoopPartialSetup({streamStarted:false,host,reservedTurnId:'owned-turn'})).toBe('setup_failed_audit_unconfirmed');
  expect(host?.core.snapshot().closing).toBe(false);expect(events).toEqual([]);
 });
});
