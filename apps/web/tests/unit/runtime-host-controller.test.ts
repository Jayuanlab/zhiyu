import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {RuntimeHostController} from '@/lib/runtime/host-controller';
const lease={ownerId:'owner',instanceId:'instance',token:1};
beforeEach(()=>vi.useFakeTimers());afterEach(()=>vi.useRealTimers());
function fixture(run=vi.fn(async(_signal:AbortSignal)=>{}),enabled=()=>true){
  const store={acquire:vi.fn(async()=>lease),heartbeat:vi.fn(async()=>true),release:vi.fn(async()=>true)};
  const host=new RuntimeHostController({store,ownerId:'owner',instanceId:'instance',mode:'worker',ttlMs:1000,
    modules:[{name:'module',intervalMs:10,timeoutMs:10000,run}],enabled});
  return {store,host,run};
}
it('requires an initial durable heartbeat before dispatch and respects pause',async()=>{
  const {store,host,run}=fixture();
  store.heartbeat.mockResolvedValueOnce(false);
  await host.step();await vi.advanceTimersByTimeAsync(0);expect(run).not.toHaveBeenCalled();expect(host.snapshot().phase).toBe('lost');
  const next=fixture();next.host.pause();await next.host.step();expect(next.run).not.toHaveBeenCalled();
  next.host.resume();await next.host.step();await vi.advanceTimersByTimeAsync(0);expect(next.run).toHaveBeenCalledTimes(1);
  await next.host.stop(0);
});
it('disabled never acquires and database errors never dispatch',async()=>{
  const disabled=fixture(undefined,()=>false);await disabled.host.step();expect(disabled.store.acquire).not.toHaveBeenCalled();
  const failed=fixture();failed.store.acquire.mockRejectedValue(Error('private connection detail'));
  await failed.host.step();expect(failed.host.snapshot().error).toBe('host_storage_unavailable');expect(failed.run).not.toHaveBeenCalled();
});
it('hung heartbeat aborts active work, blocks overlapping renewal and never restarts after late success',async()=>{
  let signal!:AbortSignal,finish!:()=>void,renew!:(value:boolean)=>void;
  const run=vi.fn((value:AbortSignal)=>{signal=value;return new Promise<void>(resolve=>{finish=resolve;});});
  const {host,store}=fixture(run);await host.step();await vi.advanceTimersByTimeAsync(0);
  store.heartbeat.mockImplementationOnce(()=>new Promise(resolve=>{renew=resolve;}));
  const pending=host.step();await host.step();
  await vi.advanceTimersByTimeAsync(1000);expect(signal.aborted).toBe(true);expect(host.snapshot().phase).toBe('lost');
  expect(host.snapshot().modules[0].inFlight).toBe(true);expect(store.heartbeat).toHaveBeenCalledTimes(2);
  renew(true);await pending;await host.step();expect(run).toHaveBeenCalledTimes(1);
  finish();await vi.advanceTimersByTimeAsync(0);
});
it('unsettled stop records stopping without releasing the owner lease',async()=>{
  let finish!:()=>void;const run=vi.fn((_signal:AbortSignal)=>new Promise<void>(resolve=>{finish=resolve;}));
  const {host,store}=fixture(run);await host.step();await vi.advanceTimersByTimeAsync(0);
  const stop=host.stop(10);await vi.advanceTimersByTimeAsync(10);
  expect((await stop).settled).toBe(false);expect(store.release).not.toHaveBeenCalled();
  expect(store.heartbeat).toHaveBeenLastCalledWith(lease,1000,expect.any(Array),'stopped');
  finish();await vi.advanceTimersByTimeAsync(0);await host.stop(0);expect(store.release).toHaveBeenCalledTimes(1);
});
it('lease confirmation expires even when the process host stops calling step',async()=>{
  let signal!:AbortSignal,finish!:()=>void;
  const {host}=fixture(vi.fn(value=>{signal=value;return new Promise<void>(resolve=>{finish=resolve;});}));
  await host.step();await vi.advanceTimersByTimeAsync(1000);
  expect(signal.aborted).toBe(true);expect(host.snapshot().phase).toBe('lost');
  finish();await vi.advanceTimersByTimeAsync(0);
});
it('a hung stop acknowledgement remains lost rather than reporting a clean stopped host',async()=>{
  const {host,store}=fixture();await host.step();await vi.advanceTimersByTimeAsync(0);
  store.release.mockImplementation(()=>new Promise(()=>{}));
  const stopped=host.stop(0);await vi.advanceTimersByTimeAsync(1000);await stopped;
  expect(host.snapshot()).toMatchObject({phase:'lost',error:'host_stop_confirmation_timeout'});
});
