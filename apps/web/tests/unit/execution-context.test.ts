import {describe,it,expect} from 'vitest';
import {withExecutionContext,resolveExecutionLease} from '@/lib/work-runtime/execution-context';
const lease={userId:'owner',workshopId:'work',runId:'run',workerId:'worker',token:1};

describe('server execution context',()=>{
  it('keeps concurrent async descendants isolated and restores the caller',async()=>{
    const results=await Promise.all([1,2].map(token=>withExecutionContext({...lease,token},async()=>{
      await new Promise(resolve=>setTimeout(resolve,token===1?10:0));
      return resolveExecutionLease()?.token;
    })));
    expect(results).toEqual([1,2]);expect(resolveExecutionLease()).toBeUndefined();
  });
  it('snapshots the capability and rejects nested replacement',async()=>{
    const original={...lease};
    await withExecutionContext(original,async()=>{
      original.token=9;await Promise.resolve();
      expect(resolveExecutionLease()?.token).toBe(1);
      expect(Object.isFrozen(resolveExecutionLease())).toBe(true);
      expect(()=>withExecutionContext(original,()=>null)).toThrow('invalid_lease');
      expect(withExecutionContext(undefined,()=>resolveExecutionLease()?.token)).toBe(1);
    });
  });
  it('does not retain context in the caller after rejection',async()=>{
    await expect(withExecutionContext(lease,async()=>{throw Error('failure');})).rejects.toThrow('failure');
    expect(resolveExecutionLease()).toBeUndefined();
  });
});
