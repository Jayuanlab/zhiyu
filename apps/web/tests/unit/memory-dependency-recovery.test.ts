import { describe, expect, it } from 'vitest';
import {
  clearPendingMemoryDependency, dependencyRecoveryKey, hasAcknowledgedMemoryDependency,
  normalizeDependencySources, normalizePendingMemoryDependency, parseMemoryDependencyReceipt,
  parseMemoryDependencySnapshot, persistPendingMemoryDependency, readPendingMemoryDependency,
  isMemoryDependencyTargetUnavailable, restoreMemoryDependencyCommandState,
  type PendingMemoryDependency,
} from '@/components/memory-dependency-recovery';

const entityId='00000000-0000-4000-8000-000000000001';
const memoryId='00000000-0000-4000-8000-000000000002';
const otherId='00000000-0000-4000-8000-000000000003';
const snapshotId='00000000-0000-4000-8000-000000000004';
const version=(prefix:string,value:string)=>`${prefix}:${value.repeat(64)}`;
const pending:PendingMemoryDependency={kind:'memory_dependency_pending.v1',ownerId:'owner',entityKind:'wiki_note',entityId,
  request:{commandId:'exact-original-command',action:'register',expectedDependencyVersion:'bmdd1:initial',
    expectedEntityVersion:version('bmde1','a'),sources:[{memoryId,expectedVersion:version('bmrv1','b')}],
    reason:'Owner compared the exact entity and source versions',evidenceConfirmed:true}};
function storage(){const values=new Map<string,string>();return {getItem:(key:string)=>values.get(key)??null,
  setItem:(key:string,value:string)=>{values.set(key,value);},removeItem:(key:string)=>{values.delete(key);}};}
function unknownSnapshot(){return {entity:{kind:'wiki_note',id:entityId,title:'Original note',status:'active',version:pending.request.expectedEntityVersion,content:'Exact derived text',contentTruncated:false},
  coverage:'unknown',dependencyVersion:'bmdd1:initial',registry:null,assessment:'unknown',reasons:['No explicit version references'],sources:[]};}
function currentSnapshot(){const source={memoryId,expectedVersion:version('bmrv1','b'),assessment:'current',reason:'Exact current version',
  oldMemory:{id:memoryId,subject:'Source',content:'Independent source assertion',status:'active',revisionVersion:version('bmrv1','b'),evidenceRefs:['fixture:source']},
  currentMemory:{id:memoryId,subject:'Source',content:'Independent source assertion',status:'active',revisionVersion:version('bmrv1','b'),evidenceRefs:['fixture:source']},
  currentVersion:version('bmrv1','b')};return {...unknownSnapshot(),coverage:'recorded',dependencyVersion:version('bmdd1','c'),
    registry:{snapshotId,sequence:1,createdAt:'2026-10-02T10:00:00Z',reason:pending.request.reason},assessment:'current',reasons:[],sources:[source]};}
function result(){return {replayed:false,receipt:{id:snapshotId,commandId:pending.request.commandId,action:'register',entityKind:pending.entityKind,
  entityId,previousDependencyVersion:'bmdd1:initial',dependencyVersion:version('bmdd1','c'),entityVersion:pending.request.expectedEntityVersion,
  sourceVersions:pending.request.sources,sequence:1,snapshotId,createdAt:'2026-10-02T10:00:00Z'}};}

describe('explicit memory dependency pending commands and receipts',()=>{
  it('preserves the full owner command through reload and refuses clearing another command',()=>{
    const store=storage();persistPendingMemoryDependency(store,pending);
    expect(readPendingMemoryDependency(store,'owner')).toEqual(pending);expect(readPendingMemoryDependency(store,'other')).toBeNull();
    expect(()=>clearPendingMemoryDependency(store,{...pending,request:{...pending.request,commandId:'other-command'}})).toThrow();
    expect(readPendingMemoryDependency(store,'owner')).toEqual(pending);
    clearPendingMemoryDependency(store,pending);expect(store.getItem(dependencyRecoveryKey('owner'))).toBeNull();
  });
  it('canonicalizes source order while retaining versions and detects duplicate IDs',()=>{
    const sources=[{memoryId:otherId,expectedVersion:version('bmrv1','d')},...pending.request.sources];
    const first=normalizePendingMemoryDependency({...pending,request:{...pending.request,sources}},'owner');
    const second=normalizePendingMemoryDependency({...pending,request:{...pending.request,sources:[...sources].reverse()}},'owner');
    expect(first).toEqual(second);expect(first.request.sources.map(source=>source.memoryId)).toEqual([memoryId,otherId]);
    expect(()=>normalizeDependencySources([...sources,{...sources[0],expectedVersion:version('bmrv1','e')}])).toThrow();
  });
  it('bounds explicit source lists at twenty and rejects unversioned or forged authority references',()=>{
    const sources=Array.from({length:20},(_,index)=>({memoryId:`00000000-0000-4000-8000-${(index+20).toString(16).padStart(12,'0')}`,expectedVersion:version('bmrv1','b')}));
    expect(normalizeDependencySources(sources)).toHaveLength(20);
    for(const value of [[],[...sources,{memoryId:otherId,expectedVersion:version('bmrv1','b')}],
      [{memoryId}], [{memoryId,expectedVersion:'id-only'}], [{...sources[0],authority:'runtime'}]]){
      expect(()=>normalizeDependencySources(value)).toThrow();
    }
  });
  it.each([
    {...pending,ownerId:'another-owner'}, {...pending,entityKind:'guessed_text'}, {...pending,entityId:'unknown'},
    {...pending,request:{...pending.request,evidenceConfirmed:false}}, {...pending,request:{...pending.request,expectedEntityVersion:'initial'}},
    {...pending,request:{...pending.request,metadata:{verified:true}}}, {...pending,unexpected:'field'},
  ])('rejects malformed or cross-owner recovery before a mutation (%j)',value=>{
    const store=storage();store.setItem(dependencyRecoveryKey('owner'),JSON.stringify(value));expect(()=>readPendingMemoryDependency(store,'owner')).toThrow();
  });
  it('does not replace an unknown command with another entity, source version or reason',()=>{
    const store=storage();persistPendingMemoryDependency(store,pending);
    for(const changed of [{...pending,entityKind:'loop' as const,entityId:otherId},
      {...pending,request:{...pending.request,reason:'Different reason'}},
      {...pending,request:{...pending.request,sources:[{memoryId,expectedVersion:version('bmrv1','f')}]}}]){
      expect(()=>persistPendingMemoryDependency(store,changed)).toThrow();expect(readPendingMemoryDependency(store,'owner')).toEqual(pending);
    }
  });
  it('fails before sending when storage is unavailable, fails readback or cannot clear',()=>{
    const store=storage();expect(()=>persistPendingMemoryDependency({...store,setItem:()=>{throw Error('quota');}},pending)).toThrow('quota');
    expect(()=>persistPendingMemoryDependency({...store,setItem:()=>{}},pending)).toThrow();
    persistPendingMemoryDependency(store,pending);expect(()=>clearPendingMemoryDependency({...store,removeItem:()=>{}},pending)).toThrow();
  });
  it('acknowledges only a normalized exact payload and a strictly empty owner slot',()=>{
    const store=storage();persistPendingMemoryDependency(store,pending);expect(hasAcknowledgedMemoryDependency(store,pending,pending)).toBe(false);
    clearPendingMemoryDependency(store,pending);expect(hasAcknowledgedMemoryDependency(store,pending,pending)).toBe(true);
    for(const acknowledgement of [null,{}, {...pending,ownerId:'other'}, {...pending,request:{...pending.request,reason:'Changed'}}]){
      expect(hasAcknowledgedMemoryDependency(store,pending,acknowledgement)).toBe(false);
    }
    for(const raw of ['', 'malformed', JSON.stringify(pending)]){
      store.setItem(dependencyRecoveryKey('owner'),raw);expect(hasAcknowledgedMemoryDependency(store,pending,pending)).toBe(false);
    }
    expect(hasAcknowledgedMemoryDependency({getItem:()=>{throw Error('unavailable');}},pending,pending)).toBe(false);
  });
  it('keeps a saved original receipt when a current GET reads the same stored command',()=>{
    const saved={pending,outcome:'saved' as const,result:parseMemoryDependencyReceipt(result(),pending),blockedCode:null};
    expect(restoreMemoryDependencyCommandState(saved,structuredClone(pending))).toBe(saved);
    expect(saved.result.receipt.commandId).toBe(pending.request.commandId);
    expect(saved.outcome).toBe('saved');
  });
  it('keeps the current busy attempt blocked without changing its original command or history',()=>{
    const blocked={pending,outcome:'blocked' as const,result:null,blockedCode:'memory_write_busy'};
    expect(restoreMemoryDependencyCommandState(blocked,structuredClone(pending))).toBe(blocked);
    expect(blocked.pending.request.reason).toBe(pending.request.reason);
    expect(blocked.blockedCode).toBe('memory_write_busy');
  });
  it('restores a stored command as unknown only when the control has no active original command',()=>{
    const idle={pending:null,outcome:'idle' as const,result:null,blockedCode:null};
    const restored=restoreMemoryDependencyCommandState(idle,structuredClone(pending));
    expect(restored).toEqual({pending,outcome:'unknown',result:null,blockedCode:null});
  });
  it('refuses to overwrite an active command with another owner, entity, command or payload',()=>{
    const saved={pending,outcome:'saved' as const,result:parseMemoryDependencyReceipt(result(),pending),blockedCode:null};
    for(const changed of [{...pending,ownerId:'other'}, {...pending,entityId:otherId},
      {...pending,request:{...pending.request,commandId:'another-command'}}, {...pending,request:{...pending.request,reason:'Changed original reason'}}]){
      expect(()=>restoreMemoryDependencyCommandState(saved,changed)).toThrow();
      expect(saved.outcome).toBe('saved');expect(saved.pending).toBe(pending);
    }
  });
  it('represents unrecorded history as unknown and a recorded exact version as current',()=>{
    expect(parseMemoryDependencySnapshot(unknownSnapshot(),'wiki_note',entityId).assessment).toBe('unknown');
    expect(parseMemoryDependencySnapshot(currentSnapshot(),'wiki_note',entityId).assessment).toBe('current');
    expect(()=>parseMemoryDependencySnapshot(currentSnapshot(),'loop',entityId)).toThrow();
    expect(()=>parseMemoryDependencySnapshot(currentSnapshot(),'wiki_note',otherId)).toThrow();
  });
  it('does not promote unknown history or an empty recorded registry to current',()=>{
    expect(()=>parseMemoryDependencySnapshot({...unknownSnapshot(),assessment:'current'},'wiki_note',entityId)).toThrow();
    expect(()=>parseMemoryDependencySnapshot({...currentSnapshot(),sources:[]},'wiki_note',entityId)).toThrow();
  });
  it('requires the exact readable entity content and validates every current source',()=>{
    const snapshot=currentSnapshot();
    for(const entity of [{...snapshot.entity,content:undefined},{...snapshot.entity,contentTruncated:undefined},{...snapshot.entity,content:'x'.repeat(12001)}]){
      expect(()=>parseMemoryDependencySnapshot({...snapshot,entity},'wiki_note',entityId)).toThrow();
    }
    for(const source of [{...snapshot.sources[0],assessment:'stale'},{...snapshot.sources[0],currentMemory:{...snapshot.sources[0].currentMemory,status:'candidate'}},
      {...snapshot.sources[0],currentMemory:{...snapshot.sources[0].currentMemory,id:otherId}},
      {...snapshot.sources[0],currentMemory:{...snapshot.sources[0].currentMemory,revisionVersion:version('bmrv1','f')}}]){
      expect(()=>parseMemoryDependencySnapshot({...snapshot,sources:[source]},'wiki_note',entityId)).toThrow();
    }
  });
  it('allows unavailable-target recovery only from the exact authenticated 404 code',()=>{
    expect(isMemoryDependencyTargetUnavailable(404,{code:'dependency_target_not_found'})).toBe(true);
    for(const [status,body] of [[400,{code:'dependency_target_not_found'}],[404,{code:'dependency_source_denied'}],[503,{code:'dependency_target_not_found'}],[404,null],[404,'dependency_target_not_found']]){
      expect(isMemoryDependencyTargetUnavailable(status as number,body)).toBe(false);
    }
  });
  it('rejects denied source bodies, duplicate IDs and mixed current versions',()=>{
    const snapshot=currentSnapshot();
    expect(()=>parseMemoryDependencySnapshot({...snapshot,sources:[{...snapshot.sources[0],assessment:'denied'}]},'wiki_note',entityId)).toThrow();
    expect(()=>parseMemoryDependencySnapshot({...snapshot,sources:[...snapshot.sources,...snapshot.sources]},'wiki_note',entityId)).toThrow();
    expect(()=>parseMemoryDependencySnapshot({...snapshot,sources:[{...snapshot.sources[0],currentVersion:version('bmrv1','f')}]},'wiki_note',entityId)).toThrow();
    expect(()=>parseMemoryDependencySnapshot({...snapshot,sources:[{...snapshot.sources[0],oldMemory:{...snapshot.sources[0].oldMemory,id:otherId}}]},'wiki_note',entityId)).toThrow();
  });
  it('accepts a durable historical replay without claiming it is the present state',()=>{
    expect(parseMemoryDependencyReceipt({...result(),replayed:true},pending).replayed).toBe(true);
    expect(parseMemoryDependencyReceipt(result(),pending).receipt.dependencyVersion).toBe(version('bmdd1','c'));
  });
  it('rejects a successful response whose command, entity, expected versions or source basis differ',()=>{
    for(const [field,value] of Object.entries({commandId:'different',action:'rebind',entityKind:'loop',entityId:otherId,
      previousDependencyVersion:version('bmdd1','f'),entityVersion:version('bmde1','f'),dependencyVersion:'bmdd1:initial',
      sequence:0,snapshotId:'malformed',createdAt:'not-a-date',sourceVersions:[{memoryId,expectedVersion:version('bmrv1','f')}]})){
      const response=result();(response.receipt as Record<string,unknown>)[field]=value;
      expect(()=>parseMemoryDependencyReceipt(response,pending),field).toThrow();
    }
    expect(()=>parseMemoryDependencyReceipt({receipt:result().receipt},pending)).toThrow();
    const rebind={...pending,request:{...pending.request,action:'rebind' as const,expectedDependencyVersion:version('bmdd1','c')}};
    expect(()=>parseMemoryDependencyReceipt({...result(),receipt:{...result().receipt,action:'rebind',previousDependencyVersion:version('bmdd1','c')}},rebind)).toThrow();
  });
});
