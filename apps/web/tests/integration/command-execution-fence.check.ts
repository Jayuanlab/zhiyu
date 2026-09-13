import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import type postgres from 'postgres';
import {claimWorkshopExecution} from '@/lib/work-runtime/execution-lease';
import {runDatabaseWorkCommand,runPreparedDatabaseWorkCommand} from '@/lib/work-runtime/database-command';
import {getWorkCommand,getWorkCommandVersion} from '@/lib/work-runtime/command-ledger';

export async function checkCommandExecutionFence(client:postgres.Sql){
  const userId=randomUUID(),workId=randomUUID(),runId=randomUUID();
  await client`INSERT INTO "User"(id,email) VALUES (${userId},'command-fence@example.invalid')`;
  await client`INSERT INTO workshops(id,user_id,name,mission) VALUES (${workId},${userId},'before','test')`;
  await client`INSERT INTO workshop_runs(id,workshop_id,status,started_at) VALUES (${runId},${workId},'queued',NULL)`;
  const target={userId,workshopId:workId,runId,workerId:'first',leaseMs:30000};
  const first=await claimWorkshopExecution(target);if(first.state!=='claimed')throw Error('not claimed');
  const command={userId,workId,commandId:randomUUID(),expectedVersion:0};
  let entered=0;
  const write=async (_:typeof command,{db,append}:import('@/lib/workshops/service').WorkshopWriteContext)=>{
    entered++;
    await db.execute(sql`UPDATE workshops SET name='fenced' WHERE id=${workId}::uuid`);
    await append({workshopId:workId,runId,type:'fence_fixture',title:'fenced write'});
    return {written:true};
  };
  await client`UPDATE workshop_execution_leases SET lease_until=clock_timestamp()-interval '1 second' WHERE workshop_id=${workId}`;
  await assert.rejects(runDatabaseWorkCommand(command,'fixture.fenced',write,first.lease),{code:'lease_lost'});
  assert.equal(entered,0);assert.equal((await getWorkCommand(userId,command.commandId))?.status,'queued');
  const replacement=await claimWorkshopExecution({...target,workerId:'second'});if(replacement.state!=='claimed')throw Error('not reclaimed');
  await assert.rejects(runDatabaseWorkCommand(command,'fixture.fenced',write,first.lease),{code:'lease_lost'});
  await assert.rejects(runDatabaseWorkCommand(command,'fixture.fenced',write,{...replacement.lease,workshopId:randomUUID()}),{code:'invalid_lease'});
  assert.deepEqual(await runDatabaseWorkCommand(command,'fixture.fenced',write,replacement.lease),{written:true});
  // Receipt recovery is read-only and keeps the original intent across tokens.
  assert.deepEqual(await runDatabaseWorkCommand(command,'fixture.fenced',write,first.lease),{written:true});
  assert.equal(entered,1);assert.equal(await getWorkCommandVersion(userId,workId),1);
  const slow={...command,commandId:randomUUID(),expectedVersion:1};
  await client`UPDATE workshop_execution_leases SET lease_until=clock_timestamp()+interval '1 second' WHERE workshop_id=${workId}`;
  await assert.rejects(runDatabaseWorkCommand(slow,'fixture.slow',async (input,context)=>{
    await write(input,context);
    await context.db.execute(sql`SELECT pg_sleep(1.1)`);
    return {written:true};
  },replacement.lease),{code:'lease_lost'});
  assert.equal(entered,2);assert.equal((await getWorkCommand(userId,slow.commandId))?.status,'queued');
  assert.equal(await getWorkCommandVersion(userId,workId),1);
  assert.equal((await client`SELECT count(*)::int AS n FROM workshop_events WHERE workshop_id=${workId} AND type='fence_fixture'`)[0].n,1);
  assert.equal((await client`SELECT count(*)::int AS n FROM work_command_events WHERE command_id=${slow.commandId} AND phase='succeeded'`)[0].n,0);
  const third=await claimWorkshopExecution({...target,workerId:'third'});if(third.state!=='claimed')throw Error('not reclaimed');
  const prepared={...command,commandId:randomUUID(),expectedVersion:1};let prepares=0;
  const prepare=async()=>{prepares++;return {name:'prepared'};};
  const apply=async (_:typeof command,draft:{name:string},context:import('@/lib/workshops/service').WorkshopWriteContext)=>{
    await context.db.execute(sql`UPDATE workshops SET name=${draft.name} WHERE id=${workId}::uuid`);return draft;
  };
  await assert.rejects(runPreparedDatabaseWorkCommand(prepared,'fixture.prepared',prepare,apply,replacement.lease),{code:'lease_lost'});
  assert.deepEqual(await runPreparedDatabaseWorkCommand(prepared,'fixture.prepared',prepare,apply,third.lease),{name:'prepared'});
  assert.equal(prepares,1);assert.equal(await getWorkCommandVersion(userId,workId),2);
  return {name:'command transaction fencing: expired/stale/cross-target rejection, recovery with stable intent, slow transaction rollback and prepared draft reuse',passed:true};
}
