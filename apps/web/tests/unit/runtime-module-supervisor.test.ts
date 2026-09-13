import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {ModuleSupervisor} from '@/lib/runtime/module-supervisor';
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(1000);});
afterEach(()=>vi.useRealTimers());
const deferred=()=>{let resolve!:(value?:unknown)=>void;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
it('isolates a 120 second ingestion from fast heartbeat and throwing modules',async()=>{
  const slow=deferred(),fast=vi.fn(async()=>{});
  const host=new ModuleSupervisor([{name:'ingestion',intervalMs:1000,timeoutMs:130000,run:()=>slow.promise},
    {name:'heartbeat',intervalMs:1000,timeoutMs:500,run:fast},
    {name:'broken',intervalMs:1000,timeoutMs:500,run:async()=>{throw Error('fixture');}}]);
  host.start();host.tick();await vi.advanceTimersByTimeAsync(0);
  for(let n=0;n<120;n++){await vi.advanceTimersByTimeAsync(1000);host.tick();await vi.advanceTimersByTimeAsync(0);}
  expect(fast).toHaveBeenCalledTimes(121);
  const active=host.snapshot().modules[0];
  expect(active).toMatchObject({inFlight:true,phase:'running',lastStartedAt:1000,lastCompletedAt:null,skipped:120});
  expect(host.snapshot().modules[2].phase).toBe('error');
  slow.resolve();await vi.advanceTimersByTimeAsync(0);
  expect(host.snapshot().modules[0]).toMatchObject({durationMs:120000,inFlight:false,phase:'success'});
});
it('retains occupancy after timeout and reports late settlement without claiming cancellation',async()=>{
  const work=deferred();let signal!:AbortSignal;
  const run=vi.fn((value:AbortSignal)=>{signal=value;return work.promise;});
  const host=new ModuleSupervisor([{name:'send',intervalMs:10,timeoutMs:50,run}]);
  host.start();host.tick();await vi.advanceTimersByTimeAsync(50);host.tick();
  expect(signal.aborted).toBe(true);expect(run).toHaveBeenCalledTimes(1);
  expect(host.snapshot().modules[0]).toMatchObject({inFlight:true,phase:'stopping',lastCompletedAt:null,lastError:'deadline_exceeded'});
  work.resolve();await vi.advanceTimersByTimeAsync(0);
  expect(host.snapshot().modules[0]).toMatchObject({phase:'settled_after_abort',inFlight:false,lastSuccessAt:null});
});
it('pause prevents new starts and bounded stop keeps unresolved work visible',async()=>{
  const work=deferred(),run=vi.fn(()=>work.promise);
  const host=new ModuleSupervisor([{name:'work',intervalMs:10,timeoutMs:10000,run}]);
  host.tick();expect(run).not.toHaveBeenCalled();
  host.start();host.tick();await vi.advanceTimersByTimeAsync(0);host.pause();host.tick();
  const stop=host.stop(100);await vi.advanceTimersByTimeAsync(100);
  expect(await stop).toEqual({settled:false,unsettled:['work']});
  host.start();host.tick();expect(run).toHaveBeenCalledTimes(1);
  work.resolve();await vi.advanceTimersByTimeAsync(0);
  expect(await host.stop(100)).toEqual({settled:true,unsettled:[]});
});
it('rejects duplicate modules and invalid timings, and returns detached state',()=>{
  const module={name:'one',intervalMs:10,timeoutMs:20,run:async()=>{}};
  expect(()=>new ModuleSupervisor([module,module])).toThrow('invalid_runtime_module');
  expect(()=>new ModuleSupervisor([{...module,timeoutMs:0}])).toThrow('invalid_runtime_module');
  const host=new ModuleSupervisor([module]);host.snapshot().modules[0].phase='error';
  expect(host.snapshot().modules[0].phase).toBe('idle');
});
it('stop before dispatch prevents the underlying operation from starting',async()=>{
  const run=vi.fn(async()=>{}),host=new ModuleSupervisor([{name:'work',intervalMs:10,timeoutMs:100,run}]);
  host.start();host.tick();const stopped=host.stop(100);
  await vi.advanceTimersByTimeAsync(0);
  expect(await stopped).toEqual({settled:true,unsettled:[]});expect(run).not.toHaveBeenCalled();
});
