import {it,expect} from 'vitest';
import {refreshDraft,editDraft,acceptDraft} from '@/lib/work-runtime/versioned-draft';
it('keeps edited values and their original version through background refresh',()=>{
  const original=refreshDraft(undefined,{enabled:false},1), edited=editDraft(original,{enabled:true});
  expect(refreshDraft(edited,{enabled:false},2)).toBe(edited);
  expect(edited.version).toBe(1);
});
it('updates a clean form but refuses an older projection',()=>{
  const current=refreshDraft(undefined,{enabled:false},2);
  expect(refreshDraft(current,{enabled:true},1)).toBe(current);
  expect(refreshDraft(current,{enabled:true},3)).toEqual({value:{enabled:true},version:3,dirty:false});
});
it('does not discard a newer edit when an older submission finishes',()=>{
  const submitted=editDraft(refreshDraft(undefined,'old',1),'submitted');
  const current=editDraft(submitted,'edited while saving');
  expect(acceptDraft(current,submitted)).toBe(current);
  const accepted=acceptDraft(submitted,submitted);expect(accepted.dirty).toBe(false);
  expect(refreshDraft(accepted,'saved',2).version).toBe(2);
});
