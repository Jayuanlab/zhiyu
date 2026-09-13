import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const renew=vi.hoisted(()=>vi.fn());
vi.mock('@/lib/work-runtime/execution-lease',()=>({renewExecutionLease:renew}));
import {startExecutionHeartbeat} from '@/lib/work-runtime/execution-heartbeat';
const lease={userId:'owner',workshopId:'work',runId:'run',workerId:'worker',token:1};
describe('execution heartbeat lifecycle',()=>{
  beforeEach(()=>{vi.useFakeTimers();renew.mockReset();renew.mockResolvedValue(new Date());});
  afterEach(()=>{vi.useRealTimers();});
  it('renews immediately and serially, then stops without leaving a timer',async()=>{
    const heartbeat=await startExecutionHeartbeat(lease,new AbortController(),3000);
    expect(renew).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(renew).toHaveBeenCalledTimes(3);
    await heartbeat.stop();
    await vi.advanceTimersByTimeAsync(10000);
    expect(renew).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('aborts on renewal failure and does not retry ownership',async()=>{
    const controller=new AbortController();
    const heartbeat=await startExecutionHeartbeat(lease,controller,3000);
    const error=new Error('database unavailable');renew.mockRejectedValue(error);
    await vi.advanceTimersByTimeAsync(1000);
    expect(controller.signal.reason).toBe(error);
    await vi.advanceTimersByTimeAsync(10000);
    expect(renew).toHaveBeenCalledTimes(2);
    await heartbeat.stop();expect(vi.getTimerCount()).toBe(0);
  });
  it('joins an in-flight renewal before shutdown and never overlaps renewals',async()=>{
    const heartbeat=await startExecutionHeartbeat(lease,new AbortController(),3000);
    let release!:()=>void;
    renew.mockImplementation(()=>new Promise<void>(resolve=>{release=resolve;}));
    await vi.advanceTimersByTimeAsync(5000);
    expect(renew).toHaveBeenCalledTimes(2);
    let stopped=false;const closing=heartbeat.stop().then(()=>{stopped=true;});
    await Promise.resolve();expect(stopped).toBe(false);
    release();await closing;
    expect(stopped).toBe(true);expect(vi.getTimerCount()).toBe(0);
  });
  it('stops on external abort and rejects startup with an aborted controller',async()=>{
    const controller=new AbortController();
    const heartbeat=await startExecutionHeartbeat(lease,controller,3000);
    controller.abort();await vi.advanceTimersByTimeAsync(10000);
    expect(renew).toHaveBeenCalledTimes(1);await heartbeat.stop();
    await expect(startExecutionHeartbeat(lease,controller,3000)).rejects.toMatchObject({code:'lease_lost'});
  });
  it('aborts and rejects initial renewal failure without starting a timer',async()=>{
    renew.mockRejectedValue(new Error('lost'));const controller=new AbortController();
    await expect(startExecutionHeartbeat(lease,controller)).rejects.toThrow('lost');
    expect(controller.signal.aborted).toBe(true);expect(vi.getTimerCount()).toBe(0);
  });
});
