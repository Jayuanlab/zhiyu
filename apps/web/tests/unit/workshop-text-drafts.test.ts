import {describe,it,expect} from 'vitest';
import {createWorkshopTextDraftStore} from '@/lib/workshops/text-drafts';
const a='11111111-1111-1111-1111-111111111111',b='22222222-2222-2222-2222-222222222222';
function storage(){const rows=new Map<string,string>();return {getItem:(key:string)=>rows.get(key)??null,setItem:(key:string,value:string)=>{rows.set(key,value);}};}
describe('workshop text drafts',()=>{
  it('restores independent drafts per owner, workshop and field',()=>{
    const disk=storage(),one=createWorkshopTextDraftStore('owner-a',disk);
    one.edit(a,'directive','direction A');one.edit(a,'loopIntent','loop A');one.edit(b,'directive','direction B');
    expect(createWorkshopTextDraftStore('owner-a',disk).getSnapshot().rows).toEqual({[a]:{directive:'direction A',loopIntent:'loop A'},[b]:{directive:'direction B',loopIntent:''}});
    expect(createWorkshopTextDraftStore('owner-b',disk).getSnapshot().rows).toEqual({});
  });
  it('does not erase newer edits or the same text in another workshop',()=>{
    const store=createWorkshopTextDraftStore('owner',storage());
    store.edit(a,'directive','sent');store.edit(b,'directive','sent');store.edit(a,'directive','new edit');
    store.acknowledge(a,'directive','sent');
    expect(store.getSnapshot().rows[a].directive).toBe('new edit');
    store.acknowledge(b,'directive','sent');
    expect(store.getSnapshot().rows[b]).toBeUndefined();expect(store.getSnapshot().rows[a].directive).toBe('new edit');
  });
  it('protects edits from a remounted editor against an old pending receipt',()=>{
    const disk=storage(),old=createWorkshopTextDraftStore('owner',disk);
    old.edit(a,'directive','sent');
    const remounted=createWorkshopTextDraftStore('owner',disk);
    remounted.edit(a,'directive','newer');remounted.edit(b,'loopIntent','another work');
    old.acknowledge(a,'directive','sent');
    const restored=createWorkshopTextDraftStore('owner',disk);
    expect(restored.getSnapshot().rows[a].directive).toBe('newer');expect(restored.getSnapshot().rows[b].loopIntent).toBe('another work');
  });
  it('keeps current edits and exposes storage failure',()=>{
    const store=createWorkshopTextDraftStore('owner',{getItem:()=>null,setItem:()=>{throw Error('quota');}});
    store.edit(a,'directive','keep this');
    expect(store.getSnapshot().rows[a].directive).toBe('keep this');expect(store.getSnapshot().warning).toContain('无法保存');
  });
  it('does not treat corrupt storage as a valid saved draft or write without an owner',()=>{
    const disk={getItem:()=>'{bad',setItem:()=>{throw Error('must not write');}};
    expect(createWorkshopTextDraftStore('owner',disk).getSnapshot().warning).toContain('无法保存');
    const anonymous=createWorkshopTextDraftStore(null,disk);anonymous.edit(a,'directive','not stored');expect(anonymous.getSnapshot().rows).toEqual({});
  });
});
