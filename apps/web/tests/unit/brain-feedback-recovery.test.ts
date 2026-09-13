import { describe, expect, it } from 'vitest';
import { feedbackRecoveryKey, readPendingRecallFeedback } from '@/lib/brain/feedback-recovery';
const payload = { feedbackId:'00000000-0000-4000-8000-000000000001',query:'Original query',outcome:'used',reason:'Useful',sources:['memory'] };
describe('feedback recovery ownership and damaged storage',()=>{
  it('reads only the current owner and preserves the request identity',()=>{
    const values = new Map([[feedbackRecoveryKey('owner-a'),JSON.stringify(payload)]]);
    const storage = {getItem:(key:string)=>values.get(key)??null};
    expect(readPendingRecallFeedback(storage,'owner-a')).toEqual(payload);
    expect(readPendingRecallFeedback(storage,'owner-b')).toBeNull();
  });
  it.each(['{broken','null',JSON.stringify({...payload,feedbackId:'broken'}),JSON.stringify({...payload,sources:[1]})])('rejects damaged state without deleting it: %s',raw=>{
    expect(()=>readPendingRecallFeedback({getItem:()=>raw},'owner')).toThrow();
  });
  it('surfaces unavailable browser storage',()=>{
    expect(()=>readPendingRecallFeedback({getItem:()=>{throw Error('Denied');}},'owner')).toThrow('Denied');
  });
});
