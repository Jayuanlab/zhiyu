import {describe,expect,it,vi} from 'vitest';
import {createWorkshopReadClient} from '@/lib/workshops/read-client';
describe('workshop read lifecycle',()=>{
  it('coalesces one URL while unrelated workshop requests progress independently',async()=>{
    let release!:(value:unknown)=>void;
    const fetcher=vi.fn((url:string)=>url==='a'?new Promise(resolve=>{release=resolve;}):Promise.resolve('b'));
    const client=createWorkshopReadClient(fetcher as <T>(url:string)=>Promise<T>);
    const a=client.read('a');expect(client.read('a')).toBe(a);
    expect(await client.read('b')).toBe('b');expect(fetcher).toHaveBeenCalledTimes(2);
    expect(client.getSnapshot().find(row=>row.url==='a')?.status).toBe('loading');
    release('a');expect(await a).toBe('a');
  });
  it('retains successful observation time through failed refresh and clears error on retry',async()=>{
    let fail=true,time=1;
    const client=createWorkshopReadClient(async<T>()=>{if(fail)throw Error('offline');return {data:'ok'} as T;},()=>time);
    await expect(client.read('/work/a')).rejects.toThrow('offline');
    expect(client.getSnapshot()[0]).toMatchObject({status:'error',lastSuccess:null});
    fail=false;await client.read('/work/a');
    fail=true;time=2;const failed=client.read('/work/a');
    expect(client.getSnapshot()[0]).toMatchObject({status:'refreshing',lastSuccess:1});
    await expect(failed).rejects.toThrow('offline');
    expect(client.getSnapshot()[0]).toMatchObject({status:'degraded',lastSuccess:1});
    fail=false;time=3;await client.read('/work/a');
    expect(client.getSnapshot()[0]).toMatchObject({status:'ready',lastSuccess:3,error:null});
  });
});
