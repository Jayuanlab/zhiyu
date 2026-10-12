import { describe, expect, it } from 'vitest';
import {
  clearPendingMemoryUpdate, hasAcknowledgedMemoryUpdate, memoryUpdateRecoveryKey, parseMemoryUpdateDecisionResult,
  parseMemoryUpdatePolicyResult, parseMemoryUpdatePolicySnapshot, parseMemoryUpdateSnapshot,
  persistPendingMemoryUpdate, readPendingMemoryUpdate,
  type PendingMemoryUpdate,
} from '@/components/memory-update-recovery';

const baseId='00000000-0000-4000-8000-000000000001',candidateId='00000000-0000-4000-8000-000000000002',receiptId='00000000-0000-4000-8000-000000000003';
const version=(value:string)=>`bmrv1:${value.repeat(64)}`;
const pending:Extract<PendingMemoryUpdate,{actionKind:'decision'}>={kind:'memory_update_pending.v1',ownerId:'owner',actionKind:'decision',candidateId,baseMemoryId:baseId,request:{action:'accept',commandId:'stable-original-command',expectedVersion:version('a'),expectedBaseVersion:version('b'),reason:'Owner checked the source',evidenceConfirmed:true}};
const policy:Extract<PendingMemoryUpdate,{actionKind:'policy'}>={kind:'memory_update_pending.v1',ownerId:'owner',actionKind:'policy',request:{commandId:'stable-policy-command',expectedVersion:'bmup1:initial',enabled:false,reason:'Owner pauses activation'}};
function storage(){const values=new Map<string,string>();return {getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);},removeItem:(key:string)=>{values.delete(key);}};}
const memory=(id:string,status:string,revisionVersion:string,metadata:Record<string,unknown>={})=>({id,subject:'fixture',content:'fixture body',status,revisionVersion,evidenceRefs:['brain-observation:source'],createdAt:'2026-10-02T08:00:00Z',updatedAt:'2026-10-02T08:01:00Z',ownerType:'work',ownerId:'work',scope:{type:'work',id:'work'},metadata});
function snapshot(){const proposal={status:'pending',targetMemoryId:baseId,expectedBaseVersion:version('b'),commandId:'proposal-command',reason:'New evidence',createdAt:'2026-10-02T08:00:00Z'};return {candidate:memory(candidateId,'candidate',version('a'),{updateProposal:proposal}),base:memory(baseId,'active',version('b')),proposalVersion:version('a'),baseVersion:version('b'),proposal};}
function accepted(){return {candidate:memory(candidateId,'active',version('c'),{updateProposal:{status:'accepted',targetMemoryId:baseId,decisionCommandId:pending.request.commandId},revision:{commandId:pending.request.commandId,previousMemoryId:baseId,previousVersion:pending.request.expectedBaseVersion}}),base:memory(baseId,'superseded',version('d'),{revisionRetired:{commandId:pending.request.commandId,nextMemoryId:candidateId}}),proposalVersion:version('c'),baseVersion:version('d'),replayed:false,receipt:{id:receiptId,commandId:pending.request.commandId,action:'accept',status:'accepted',candidateId,baseMemoryId:baseId,previousProposalVersion:version('a'),previousBaseVersion:version('b'),proposalVersion:version('c'),baseVersion:version('d'),effective:true,createdAt:'2026-10-02T08:02:00Z'}};}

describe('memory update pending command and strict receipts',()=>{
  it('retains the exact owner-scoped command across reload and permits only matching acknowledgement',()=>{
    const store=storage();persistPendingMemoryUpdate(store,pending);
    expect(readPendingMemoryUpdate(store,'owner')).toEqual(pending);expect(readPendingMemoryUpdate(store,'other-owner')).toBeNull();
    clearPendingMemoryUpdate(store,{...pending,request:{...pending.request,commandId:'other-command'}});
    expect(readPendingMemoryUpdate(store,'owner')).toEqual(pending);
    clearPendingMemoryUpdate(store,pending);expect(readPendingMemoryUpdate(store,'owner')).toBeNull();
  });
  it('does not replace a decision with another decision or policy while the first result is unknown',()=>{
    const store=storage();persistPendingMemoryUpdate(store,pending);
    expect(()=>persistPendingMemoryUpdate(store,{...pending,request:{...pending.request,reason:'Changed payload'}})).toThrow();
    expect(()=>persistPendingMemoryUpdate(store,policy)).toThrow();expect(readPendingMemoryUpdate(store,'owner')).toEqual(pending);
  });
  it.each([
    {...pending,ownerId:'foreign-owner'},
    {...pending,actionKind:'revision'},
    {...pending,candidateId:baseId},
    {...pending,request:{...pending.request,expectedBaseVersion:'malformed'}},
    {...pending,request:{...pending.request,evidenceConfirmed:false}},
    {...pending,request:{...pending.request,metadata:{authority:'runtime'}}},
  ])('refuses a malformed or cross-owner stored command before mutation (%j)',value=>{
    const store=storage();store.setItem(memoryUpdateRecoveryKey('owner'),JSON.stringify(value));expect(()=>readPendingMemoryUpdate(store,'owner')).toThrow();
  });
  it('fails closed when storage writes fail or cannot be read back',()=>{
    const store=storage();expect(()=>persistPendingMemoryUpdate({...store,setItem:()=>{throw Error('quota');}},pending)).toThrow('quota');
    expect(()=>persistPendingMemoryUpdate({...store,setItem:()=>{}},pending)).toThrow();
  });
  it('validates candidate/base identities, both versions and owner scope before enabling decision controls',()=>{
    expect(parseMemoryUpdateSnapshot(snapshot(),candidateId)).toEqual(snapshot());
    const bad=snapshot();bad.base.ownerId='other-work';expect(()=>parseMemoryUpdateSnapshot(bad,candidateId)).toThrow();
    const stale=snapshot();stale.baseVersion=version('f');expect(()=>parseMemoryUpdateSnapshot(stale,candidateId)).toThrow();
  });
  it('accepts durable replay and rejects changed command, prior versions, current versions, identities, states and effect',()=>{
    expect(parseMemoryUpdateDecisionResult({...accepted(),replayed:true},pending).replayed).toBe(true);
    for(const [field,value] of Object.entries({commandId:'different-command',previousProposalVersion:version('f'),previousBaseVersion:version('f'),proposalVersion:version('f'),baseVersion:version('f'),candidateId:baseId,effective:false,status:'rejected'})){
      const result=accepted();(result.receipt as Record<string,unknown>)[field]=value;expect(()=>parseMemoryUpdateDecisionResult(result,pending),field).toThrow();
    }
    const wrongState=accepted();wrongState.base.status='active';expect(()=>parseMemoryUpdateDecisionResult(wrongState,pending)).toThrow();
  });
  it('accepts a rejected proposal without claiming that its base retired',()=>{
    const rejectedPending={...pending,request:{...pending.request,action:'reject' as const,evidenceConfirmed:undefined}};
    const result=accepted();result.candidate.status='deleted';result.base=memory(baseId,'active',version('b'));result.baseVersion=version('b');result.candidate.metadata={updateProposal:{status:'rejected',targetMemoryId:baseId,decisionCommandId:pending.request.commandId}};Object.assign(result.receipt,{action:'reject',status:'rejected',baseVersion:version('b'),effective:false});
    expect(parseMemoryUpdateDecisionResult(result,rejectedPending).receipt.effective).toBe(false);
  });
  it('preserves policy command identity and validates the append-only snapshot receipt',()=>{
    const store=storage();persistPendingMemoryUpdate(store,policy);expect(readPendingMemoryUpdate(store,'owner')).toEqual(policy);
    const result={enabled:false,version:`bmup1:${'c'.repeat(64)}`,snapshotId:receiptId,replayed:true,receipt:{id:receiptId,commandId:policy.request.commandId,enabled:false,previousVersion:'bmup1:initial',version:`bmup1:${'c'.repeat(64)}`,snapshotId:receiptId,createdAt:'2026-10-02T08:00:00Z'}};
    expect(parseMemoryUpdatePolicyResult(result,policy).replayed).toBe(true);
    expect(()=>parseMemoryUpdatePolicyResult({...result,enabled:true},policy)).toThrow();
    expect(()=>parseMemoryUpdatePolicyResult({...result,receipt:{...result.receipt,previousVersion:'bmup1:invalid'}},policy)).toThrow();
    expect(()=>parseMemoryUpdatePolicySnapshot({enabled:false,version:'bmup1:initial',snapshotId:receiptId})).toThrow();
  });
  it.each([pending,policy])('reconciles a second instance only after exact acknowledgement and an empty owner slot (%j)',record=>{
    const store=storage();persistPendingMemoryUpdate(store,record);
    expect(hasAcknowledgedMemoryUpdate(store,record,record)).toBe(false);
    clearPendingMemoryUpdate(store,record);
    const reordered={...record,request:Object.fromEntries(Object.entries(record.request).reverse())};
    expect(hasAcknowledgedMemoryUpdate(store,record,reordered)).toBe(true);
    expect(store.getItem(memoryUpdateRecoveryKey(record.ownerId))).toBeNull();
  });
  it('does not release another owner, command, payload or malformed acknowledgement',()=>{
    const store=storage();
    for(const acknowledged of [null,{},policy,{...pending,ownerId:'other-owner'},
      {...pending,request:{...pending.request,commandId:'different-command'}},
      {...pending,request:{...pending.request,reason:'different reason'}},
      {...pending,request:{...pending.request,expectedBaseVersion:version('c')}},
      {...pending,unexpected:'field'}]){
      expect(hasAcknowledgedMemoryUpdate(store,pending,acknowledged)).toBe(false);
    }
  });
  it('keeps an unknown instance when any storage slot remains or reading fails',()=>{
    const store=storage();
    for(const value of [JSON.stringify(policy),JSON.stringify(pending),'malformed','']){
      store.setItem(memoryUpdateRecoveryKey('owner'),value);
      expect(hasAcknowledgedMemoryUpdate(store,pending,pending)).toBe(false);
      expect(store.getItem(memoryUpdateRecoveryKey('owner'))).toBe(value);
    }
    expect(hasAcknowledgedMemoryUpdate({getItem:()=>{throw Error('unavailable');}},pending,pending)).toBe(false);
  });
});
