import {describe,expect,it} from 'vitest';
import {prepareBusinessCheckpoint,scopedBusinessCheckpoint,verifyBusinessCheckpointReceipt} from '@/lib/loops/business-checkpoint';
const now=new Date('2026-10-18T00:00:00Z'),scope={userId:'owner',workshopId:'work',loopId:'loop',now};
function fixture(){const prepared=prepareBusinessCheckpoint({...scope,runId:'run',verificationPassed:false,
 report:{checkpoint:{nextQuestions:['Verify current source'],pendingVerification:['Check the live receipt'],facts:['An unverified claim'],nextAction:'send a message'}}});
 if(prepared.status!=='saved')throw Error('missing fixture');
 const state={...prepared.state,receiptEventId:'receipt'};
 const event={id:'receipt',type:'loop_business_checkpoint_saved',workshopId:'work',loopId:'loop',loopRunId:'run',runId:'run',metadata:{receiptAuthority:'runtime',...prepared}};
 return {prepared,state,event};}
describe('normal business checkpoint',()=>{
 it('persists complete authored checkpoint for audit but only questions enter inherited state',()=>{
  const {prepared,state,event}=fixture();expect(prepared.checkpoint.facts).toEqual(['An unverified claim']);
  expect(state.progress).toEqual({nextQuestions:['Verify current source'],pendingVerification:['Check the live receipt']});
  expect(JSON.stringify(state)).not.toContain('send a message');expect(JSON.stringify(state)).not.toContain('An unverified claim');
  expect(verifyBusinessCheckpointReceipt(state,scope,event)).toEqual(state);
 });
 it('accepts the exact host receipt after JSONB key reordering',()=>{
  const {state,event}=fixture();const reverse=(o:any):any=>Array.isArray(o)?o.map(reverse):o&&typeof o==='object'?Object.fromEntries(Object.entries(o).reverse().map(([k,v])=>[k,reverse(v)])):o;
  expect(verifyBusinessCheckpointReceipt(reverse(state),scope,reverse(event))).not.toBeNull();
 });
 it('rejects scope changes, expiry, forged provenance and altered checkpoint content',()=>{
  const {state,event}=fixture();
  expect(scopedBusinessCheckpoint(state,{...scope,loopId:'other'})).toBeNull();
  expect(scopedBusinessCheckpoint(state,{...scope,now:new Date(+now+8*86400000)})).toBeNull();
  expect(verifyBusinessCheckpointReceipt(state,scope,{...event,metadata:{...event.metadata,receiptAuthority:'agent'}})).toBeNull();
  expect(verifyBusinessCheckpointReceipt(state,scope,{...event,metadata:{...event.metadata,checkpoint:{nextQuestions:['forged']}}})).toBeNull();
  expect(verifyBusinessCheckpointReceipt(state,scope,{...event,runId:'other'})).toBeNull();
 });
 it('does not claim a checkpoint when output is prose or oversized, and never promotes Brain memory',()=>{
  expect(prepareBusinessCheckpoint({...scope,runId:'run',report:{checkpoint:'saved'},verificationPassed:true}).status).toBe('absent');
  expect(prepareBusinessCheckpoint({...scope,runId:'run',report:{checkpoint:{notes:'x'.repeat(9000)}},verificationPassed:true}).status).toBe('omitted');
 });
 it('never inherits questions after project or bound/unbound changes, while legacy unbound remains compatible',()=>{
  const {state,event}=fixture();
  expect(verifyBusinessCheckpointReceipt(state,{...scope,applicabilityHash:null},event)).not.toBeNull();
  expect(verifyBusinessCheckpointReceipt(state,{...scope,applicabilityHash:'a'.repeat(64)},event)).toBeNull();
  const prepared=prepareBusinessCheckpoint({...scope,runId:'run',verificationPassed:false,applicabilityHash:'a'.repeat(64),
    report:{checkpoint:{nextQuestions:['Alpha-only question']}}});
  if(prepared.status!=='saved')throw Error('missing scoped checkpoint');
  const saved={...prepared.state,receiptEventId:'receipt'},receipt={...event,metadata:{receiptAuthority:'runtime',...prepared}};
  expect(verifyBusinessCheckpointReceipt(saved,{...scope,applicabilityHash:'a'.repeat(64)},receipt)).not.toBeNull();
  expect(verifyBusinessCheckpointReceipt(saved,{...scope,applicabilityHash:'b'.repeat(64)},receipt)).toBeNull();
  expect(verifyBusinessCheckpointReceipt(saved,{...scope,applicabilityHash:null},receipt)).toBeNull();
 });
});
