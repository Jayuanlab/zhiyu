import {beforeEach,expect,it,vi} from 'vitest';
import {createWorkModules} from '@/lib/runtime/work-modules';
const mocks=vi.hoisted(()=>({admit:vi.fn(),loop:vi.fn(),work:vi.fn(),heartbeat:vi.fn(),processing:vi.fn(),ingestion:vi.fn(),outbox:vi.fn(),reviews:vi.fn()}));
vi.mock('@/lib/interactions/processing-jobs',()=>({countInteractionProcessingReviews:mocks.reviews,recoverInterruptedInteractionJobs:async()=>0}));
vi.mock('@/lib/work-runtime/outbox-recovery',()=>({recoverOwnedOutbox:mocks.outbox}));
vi.mock('@/lib/knowledge-pipeline/ingestion-runtime',()=>({runDueInteractionIngestion:mocks.ingestion}));
vi.mock('@/lib/interactions/worker',()=>({runPendingInteractionProcessingJobs:mocks.processing}));
vi.mock('@/lib/workshops/heartbeat-scheduler',()=>({runDueWorkshopHeartbeats:mocks.heartbeat}));
vi.mock('@/lib/loops/native-scheduler',()=>({runDueNativeLoops:mocks.admit}));
vi.mock('@/lib/work-runtime/loop-consumer',()=>({consumeOwnedLoopRuns:mocks.loop}));
vi.mock('@/lib/work-runtime/run-consumer',()=>({consumeOwnedWorkRuns:mocks.work}));
beforeEach(()=>{vi.resetAllMocks();mocks.reviews.mockResolvedValue(0);mocks.admit.mockResolvedValue({});mocks.loop.mockResolvedValue([]);mocks.work.mockResolvedValue([]);mocks.heartbeat.mockResolvedValue({errors:[]});mocks.processing.mockResolvedValue({failed:0});mocks.ingestion.mockResolvedValue({lastStatus:'success'});mocks.outbox.mockResolvedValue({errors:0,unconfirmed:0});});
it('keeps unresolved partial understanding writes visible on later empty scans',async()=>{
  mocks.reviews.mockResolvedValue(1);
  const module=createWorkModules('owner','instance').find(module=>module.name==='interaction-processing')!;
  await expect(module.run(new AbortController().signal)).rejects.toThrow('interaction_processing_needs_review');
  expect(mocks.reviews).toHaveBeenCalledWith('owner');
});
it('passes the explicit owner, instance and cancellation to the existing engines',async()=>{
  const signal=new AbortController().signal;
  await Promise.all(createWorkModules('owner','instance').map(module=>module.run(signal)));
  expect(mocks.admit).toHaveBeenCalledWith({userId:'owner',signal});
  expect(mocks.heartbeat).toHaveBeenCalledWith({userId:'owner',signal});
  expect(mocks.outbox).toHaveBeenCalledWith({userId:'owner',workerId:'instance',signal,limit:10});
  for(const mock of [mocks.loop,mocks.work])expect(mock).toHaveBeenCalledWith({userId:'owner',workerId:'instance',signal,limit:5});
});
it('exposes unresolved outbox observations instead of reporting recovery success',async()=>{
  mocks.outbox.mockResolvedValue({errors:0,unconfirmed:1});
  const module=createWorkModules('owner','instance').find(module=>module.name==='outbox-recovery')!;
  await expect(module.run(new AbortController().signal)).rejects.toThrow('outbox_result_unconfirmed');
});
it('does not claim after cancellation while loading a module',async()=>{
  await Promise.all(createWorkModules('owner','instance').map(module=>module.run(AbortSignal.abort())));
  for(const mock of Object.values(mocks))expect(mock).not.toHaveBeenCalled();
});
it('keeps the consumer pending until its actual execution settles',async()=>{
  let finish!:(value:unknown[])=>void;
  mocks.loop.mockReturnValue(new Promise(resolve=>{finish=resolve;}));
  let settled=false;
  const result=createWorkModules('owner','instance')[1].run(new AbortController().signal).then(()=>{settled=true;});
  await vi.waitFor(()=>expect(mocks.loop).toHaveBeenCalled());
  expect(settled).toBe(false);finish([]);await result;expect(settled).toBe(true);
});
it('reports returned engine failures without exposing their details as a successful module tick',async()=>{
  mocks.admit.mockResolvedValue({errors:[{message:'private connection detail'}]});
  mocks.loop.mockResolvedValue([{state:'error'}]);mocks.work.mockResolvedValue([{state:'error'}]);
  const modules=createWorkModules('owner','instance');
  for(const [i,code] of ['loop_admission_failed','loop_execution_failed','work_execution_failed'].entries())
    await expect(modules[i].run(new AbortController().signal)).rejects.toThrow(code);
});
it('identifies unmigrated due loops without collapsing the actionable reason',async()=>{
  mocks.admit.mockResolvedValue({errors:[{loopId:'legacy',code:'loop_migration_required',message:'private task detail'}]});
  await expect(createWorkModules('owner','instance')[0].run(new AbortController().signal)).rejects.toThrow('loop_migration_required');
});
it('does not hide operational failures when a legacy loop also needs migration',async()=>{
  mocks.admit.mockResolvedValue({errors:[{code:'loop_migration_required'},{message:'database unavailable'}]});
  await expect(createWorkModules('owner','instance')[0].run(new AbortController().signal)).rejects.toThrow('loop_admission_failed');
});
