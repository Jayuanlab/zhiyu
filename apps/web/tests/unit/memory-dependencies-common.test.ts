import {describe,expect,it} from 'vitest';
import {
  deriveMemoryDependencyAssessment, getMemoryDependencyEntityVersion, getMemoryDependencyRegistryVersion,
  isDependencyHuman, memoryDependencyRecordId, memoryIsDependencyCurrent, parseMemoryDependencyEntity,
  parseMemoryDependencySources,
} from '@/lib/brain/memory-dependencies-common';
import type {BrainMemory} from '@/lib/brain/types';

const id='00000000-0000-4000-8000-000000000001';
const source={memoryId:id,expectedVersion:`bmrv1:${'a'.repeat(64)}`};
const now=new Date('2026-10-02T10:00:00Z');
const memory:BrainMemory={id,userId:'owner',scope:{type:'global'},ownerType:'chat',ownerId:'owner',memoryType:'insight',subject:'Source',
  content:'Explicit persisted assertion',status:'active',confidence:80,evidenceRefs:['fixture:original'],createdAt:now.toISOString(),updatedAt:now.toISOString()};

describe('exact memory dependency control primitives',()=>{
  it('gives denial priority and preserves unknown coverage without inventing a verified edge',()=>{
    expect(deriveMemoryDependencyAssessment({recorded:false,entityCurrent:true,sourceAssessments:[]})).toBe('unknown');
    expect(deriveMemoryDependencyAssessment({recorded:false,entityCurrent:true,sourceAssessments:['denied']})).toBe('denied');
    expect(deriveMemoryDependencyAssessment({recorded:true,entityCurrent:false,sourceAssessments:['current','denied','stale']})).toBe('denied');
  });
  it('requires the entity and every nonempty explicit source to remain current',()=>{
    expect(deriveMemoryDependencyAssessment({recorded:true,entityCurrent:true,sourceAssessments:['current','current']})).toBe('current');
    for(const input of [{recorded:true,entityCurrent:false,sourceAssessments:['current'] as const},
      {recorded:true,entityCurrent:true,sourceAssessments:[]},
      {recorded:true,entityCurrent:true,sourceAssessments:['current','stale'] as const},
      {recorded:true,entityCurrent:true,sourceAssessments:['unknown'] as const}]){
      expect(deriveMemoryDependencyAssessment({...input,sourceAssessments:[...input.sourceAssessments]})).toBe('stale');
    }
  });
  it('does not admit candidate, retired, weakened or expired source versions as current',()=>{
    expect(memoryIsDependencyCurrent(memory,now)).toBe(true);
    expect(memoryIsDependencyCurrent({...memory,status:'verified'},now)).toBe(true);
    for(const status of ['candidate','superseded','deleted','weakened'] as const){expect(memoryIsDependencyCurrent({...memory,status},now)).toBe(false);}
    for(const expiresAt of ['2026-10-02T09:59:59Z',now.toISOString(),'not-a-date']){
      expect(memoryIsDependencyCurrent({...memory,expiresAt},now)).toBe(false);
    }
    expect(memoryIsDependencyCurrent({...memory,expiresAt:'2026-10-02T10:00:01Z'},now)).toBe(true);
    expect(memoryIsDependencyCurrent({...memory,metadata:{updateProposal:{status:'pending'}}},now)).toBe(false);
  });
  it('accepts only explicit UUID and bmrv1 pairs, normalizes identity and rejects hidden authority',()=>{
    expect(parseMemoryDependencySources([source])).toEqual([source]);
    expect(parseMemoryDependencyEntity('loop',id.toUpperCase())).toEqual({entityKind:'loop',entityId:id});
    for(const value of [[],[{memoryId:id}], [{...source,expectedVersion:'id-only'}], [{...source,metadata:{verified:true}}], [source,source]]){
      expect(()=>parseMemoryDependencySources(value)).toThrow();
    }
    expect(()=>parseMemoryDependencySources(Array.from({length:21},()=>source))).toThrow();
    expect(()=>parseMemoryDependencyEntity('semantic_relation',id)).toThrow();
  });
  it('keeps entity versions stable under object ordering but changes when persisted content changes',()=>{
    const original=getMemoryDependencyEntityVersion({id,title:'A',body:'Historical body',dueAt:now});
    expect(getMemoryDependencyEntityVersion({dueAt:new Date(now),body:'Historical body',title:'A',id})).toBe(original);
    expect(getMemoryDependencyEntityVersion({id,title:'A',body:'Owner changed body',dueAt:now})).not.toBe(original);
    expect(getMemoryDependencyEntityVersion({id,title:'A',body:'Historical body',dueAt:new Date(now.getTime()+1000)})).not.toBe(original);
  });
  it('separates initial coverage from immutable registry identity and its exact basis',()=>{
    expect(getMemoryDependencyRegistryVersion(null)).toBe('bmdd1:initial');
    const original=getMemoryDependencyRegistryVersion({id,content:{sources:[source],entityVersion:'entity-a'}});
    expect(getMemoryDependencyRegistryVersion({id,content:{entityVersion:'entity-a',sources:[source]}})).toBe(original);
    expect(getMemoryDependencyRegistryVersion({id,content:{sources:[source],entityVersion:'entity-b'}})).not.toBe(original);
  });
  it('creates stable user-scoped command receipts and separates commands and purposes',()=>{
    const receipt=memoryDependencyRecordId('OWNER','same-command','registry');
    expect(memoryDependencyRecordId('owner','same-command','registry')).toBe(receipt);
    expect(memoryDependencyRecordId('other','same-command','registry')).not.toBe(receipt);
    expect(memoryDependencyRecordId('owner','other-command','registry')).not.toBe(receipt);
    expect(memoryDependencyRecordId('owner','same-command','change')).not.toBe(receipt);
  });
  it('does not treat the model Brain MCP requester or Work executor as a human acknowledgement',()=>{
    expect(isDependencyHuman({type:'chat',userId:'owner',id:'human'})).toBe(true);
    expect(isDependencyHuman({type:'chat',userId:'owner',id:'brain-mcp'})).toBe(false);
    expect(isDependencyHuman({type:'work',userId:'owner',id:'work'})).toBe(false);
  });
});
