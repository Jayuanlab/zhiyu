import {describe,expect,it} from 'vitest';
import {currentExecutionWriteContext,withExecutionWriteContext} from '@/lib/work-runtime/execution-write-context';
import {resolveExecutionLease} from '@/lib/work-runtime/execution-context';
const lease={userId:'owner',workshopId:'work',runId:'run',workerId:'worker',token:1};
const context={db:{},append:async()=>undefined} as any;
describe('transaction scope lifetime',()=>{
  it('propagates the capability and transaction only inside the awaited callback',async()=>{
    await withExecutionWriteContext(lease,context,async()=>{
      await Promise.resolve();expect(resolveExecutionLease()).toEqual(lease);
      expect(currentExecutionWriteContext(lease)).toBe(context);
    });
    expect(resolveExecutionLease()).toBeUndefined();expect(currentExecutionWriteContext(lease)).toBeUndefined();
  });
  it('rejects another worker and another nested transaction',async()=>{
    await withExecutionWriteContext(lease,context,async()=>{
      expect(()=>currentExecutionWriteContext({...lease,token:2})).toThrow('invalid_lease');
      await expect(withExecutionWriteContext(lease,{...context,db:{}},async()=>undefined)).rejects.toThrow('invalid_lease');
    });
  });
  it('rejects async descendants that escape the callback lifetime',async()=>{
    let release!:()=>void;const waiting=new Promise<void>(resolve=>{release=resolve;});let late!:Promise<unknown>;
    await withExecutionWriteContext(lease,context,async()=>{
      late=waiting.then(()=>{expect(()=>currentExecutionWriteContext(lease)).toThrow('invalid_lease');});
    });
    release();await late;
  });
});
