import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type postgres from 'postgres';
import {claimWorkshopExecution} from '@/lib/work-runtime/execution-lease';
import {createExecutionGuard} from '@/lib/work-runtime/execution-guard';
import {executionHooks} from '@/lib/ai/extensions/agent/claude/execution-hooks';

export async function checkExecutionGuard(client:postgres.Sql){
  const userId=randomUUID(),workshopId=randomUUID(),runId=randomUUID();
  await client`INSERT INTO "User"(id,email) VALUES (${userId},'execution-guard@example.invalid')`;
  await client`INSERT INTO workshops(id,user_id,name,mission) VALUES (${workshopId},${userId},'guard','test')`;
  await client`INSERT INTO workshop_runs(id,workshop_id,status,started_at) VALUES (${runId},${workshopId},'queued',NULL)`;
  const target={userId,workshopId,runId,workerId:'first',leaseMs:30000};
  const first=await claimWorkshopExecution(target);if(first.state!=='claimed')throw Error('not claimed');
  const controller=new AbortController(),guard=createExecutionGuard(first.lease,controller);
  const invoke=executionHooks(guard,controller).hooks!.PreToolUse![0].hooks[0];
  const input={hook_event_name:'PreToolUse',tool_name:'Bash',tool_use_id:'fixture',tool_input:{command:'never dispatched'}} as const;
  const context={signal:new AbortController().signal};
  assert.deepEqual(await invoke(input as any,'fixture',context),{});
  await client`UPDATE workshop_execution_leases SET lease_until=clock_timestamp()-interval '1 second' WHERE workshop_id=${workshopId}`;
  const output=await invoke(input as any,'fixture',context) as any;
  assert.equal(output.continue,false);assert.equal(output.hookSpecificOutput.permissionDecision,'deny');assert.equal(controller.signal.aborted,true);
  const next=await claimWorkshopExecution({...target,workerId:'replacement'});if(next.state!=='claimed')throw Error('not reclaimed');
  await assert.rejects(guard(),{code:'lease_lost'});
  const replacement=new AbortController();await createExecutionGuard(next.lease,replacement)();assert.equal(replacement.signal.aborted,false);
  const stale=new AbortController();await assert.rejects(createExecutionGuard(first.lease,stale)(),{code:'lease_lost'});assert.equal(stale.signal.aborted,true);
  const missing=new AbortController();await assert.rejects(createExecutionGuard({...next.lease,userId:randomUUID()},missing)(),{code:'not_found'});assert.equal(missing.signal.aborted,true);
  return {name:'SDK pre-tool hook with real PostgreSQL fence: valid check, expiration denies and aborts, stopped/stale workers cannot resume, replacement succeeds',passed:true};
}
