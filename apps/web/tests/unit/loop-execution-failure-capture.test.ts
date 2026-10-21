import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

const fixture=vi.hoisted(()=>({lease:null as any,captured:null as any,events:[] as any[],failedLoop:false,phase:'running',completeFault:false}));
const lease={userId:'owner',workshopId:'work',runId:'run',workerId:'worker',token:1};
const dialect=new PgDialect();
async function executeSql(query:any){
  const {sql,params}=dialect.sqlToQuery(query);
  if(sql.includes('SELECT x.result_json'))return [{result_json:fixture.captured,active:true,status:'running'}];
  if(sql.includes('SELECT result_json'))return [{result_json:fixture.captured}];
  if(sql.includes('SELECT 1 FROM workshop_loop_executions'))return [{}];
  if(sql.includes('UPDATE workshop_loop_executions SET result_json')){fixture.captured=JSON.parse(params[0] as string);return [];}
  if(sql.includes('UPDATE loop_runs SET'))fixture.failedLoop=true;
  if(sql.includes('UPDATE loop_states SET'))fixture.phase='error';
  return [];
}
vi.mock('@/lib/db/client',()=>({db:{execute:(q:any)=>executeSql(q)}}));
vi.mock('@/lib/work-runtime/loop-command',()=>({acceptWorkLoopExecution:vi.fn(async()=>({runId:'run'}))}));
vi.mock('@/lib/work-runtime/execution-context',()=>({resolveExecutionLease:()=>fixture.lease,withExecutionContext:async(l:any,fn:any)=>{fixture.lease=l;try{return await fn();}finally{fixture.lease=null;}}}));
vi.mock('@/lib/work-runtime/execution-write-context',()=>({withExecutionWriteContext:async(_l:any,_c:any,fn:any)=>fn()}));
vi.mock('@/lib/work-runtime/execution-lease',()=>({
  claimWorkshopExecution:vi.fn(async()=>({state:'claimed',lease})),
  withExecutionWrite:async(_l:any,fn:any)=>fn({db:{execute:(q:any)=>executeSql(q)},append:async(e:any)=>fixture.events.push(e)}),
  finishWorkshopExecution:vi.fn(async(_lease:any,outcome:any)=>{
    if(JSON.stringify(outcome.loopResult.result)!==JSON.stringify(fixture.captured))throw Error('result_conflict');
    if(fixture.completeFault){fixture.completeFault=false;throw Error('completion storage temporarily unavailable');}
  }),
}));
vi.mock('@/lib/work-runtime/execution-heartbeat',()=>({startExecutionHeartbeat:async()=>({stop:async()=>{}})}));
vi.mock('@/lib/work-runtime/loop-admission',()=>({setLoopScheduleExecutionPhase:async()=>{}}));
vi.mock('@/lib/work-runtime/recorded-step',()=>({applyRecordedStep:async(c:any,_l:any,_k:any,_i:any,fn:any)=>fn(c)}));
vi.mock('@/lib/brain/memory-dependencies',()=>({MemoryDependencyError:class extends Error{},assertMemoryDependenciesCurrentInTransaction:async()=>{}}));
import { executeAcceptedWorkLoop } from '@/lib/work-runtime/loop-execution';
import { finishWorkshopExecution } from '@/lib/work-runtime/execution-lease';
import { ExecutionLeaseError } from '@/lib/work-runtime/execution-errors';
const command={userId:'owner',workId:'work',loopId:'loop',commandId:'command'} as any;
beforeEach(()=>{vi.clearAllMocks();fixture.lease=null;fixture.captured=null;fixture.events=[];fixture.failedLoop=false;fixture.phase='running';fixture.completeFault=false;});
describe('failure before native result capture',()=>{
  it('commits a failed result before finalization so a deterministic context failure reaches terminal state',async()=>{
    const execute=vi.fn(async()=>{throw new Error('Loop execution requires recovery',{cause:new Error('loop_workshop_required_context_budget_exceeded')});});
    const result=await executeAcceptedWorkLoop(command,execute);
    expect(result.status).toBe('error');
    expect(fixture.captured).toEqual(result);
    expect(fixture.failedLoop).toBe(true);
    expect(fixture.phase).toBe('error');
    expect(fixture.events).toContainEqual(expect.objectContaining({type:'loop_execution_failure_captured',metadata:expect.objectContaining({reasonCode:'loop_workshop_required_context_budget_exceeded'})}));
    expect(finishWorkshopExecution).toHaveBeenCalledWith(lease,expect.objectContaining({status:'failed'}));
  });
  it('replays the captured failure after a finalization fault without re-entering the executor',async()=>{
    fixture.completeFault=true;
    const execute=vi.fn(async()=>{throw Error('deterministic failure');});
    await expect(executeAcceptedWorkLoop(command,execute)).rejects.toThrow('completion storage');
    const recovered=await executeAcceptedWorkLoop(command,execute);
    expect(recovered.status).toBe('error');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(fixture.events.filter(e=>e.type==='loop_execution_failure_captured')).toHaveLength(1);
  });
  it('does not turn lease loss into a captured business failure',async()=>{
    await expect(executeAcceptedWorkLoop(command,async()=>{throw new ExecutionLeaseError('lease_lost');})).rejects.toMatchObject({code:'lease_lost'});
    expect(fixture.captured).toBeNull();
    expect(finishWorkshopExecution).not.toHaveBeenCalled();
  });
});
