import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type postgres from 'postgres';
import {acceptWorkLoopExecution} from '@/lib/work-runtime/loop-command';
import {consumeOwnedWorkRuns} from '@/lib/work-runtime/run-consumer';

export async function checkLoopAcceptance(client:postgres.Sql){
  const userId=randomUUID(),workId=randomUUID(),loopId=randomUUID();
  await client`INSERT INTO "User"(id,email) VALUES (${userId},'loop-command@example.invalid')`;
  await client`INSERT INTO workshops(id,user_id,name,mission) VALUES (${workId},${userId},'loop command','test')`;
  await client`INSERT INTO loops(id,user_id,workshop_id,name,goal) VALUES (${loopId},${userId},${workId},'loop','observe')`;
  const command={userId,workId,loopId,mode:'dry_run' as const,triggeredBy:'manual' as const,commandId:randomUUID()};
  await assert.rejects(acceptWorkLoopExecution({...command,userId:randomUUID()}));
  await client.unsafe(`CREATE FUNCTION reject_loop_accept_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='loop_execution_accepted' THEN RAISE EXCEPTION 'accept event fault'; END IF; RETURN NEW; END $$`);
  await client.unsafe('CREATE TRIGGER reject_loop_accept_event BEFORE INSERT ON workshop_events FOR EACH ROW EXECUTE FUNCTION reject_loop_accept_event()');
  await assert.rejects(acceptWorkLoopExecution(command));
  assert.equal((await client`SELECT count(*)::int AS n FROM workshop_runs WHERE workshop_id=${workId}`)[0].n,0);
  assert.equal((await client`SELECT count(*)::int AS n FROM loop_runs WHERE loop_id=${loopId}`)[0].n,0);
  assert.equal((await client`SELECT count(*)::int AS n FROM workshop_loop_executions WHERE loop_id=${loopId}`)[0].n,0);
  await client.unsafe('DROP TRIGGER reject_loop_accept_event ON workshop_events');
  const [a,b]=await Promise.all([acceptWorkLoopExecution(command),acceptWorkLoopExecution(command)]);
  assert.deepEqual(a,b);assert.equal(a.runId,a.loopRunId);assert.equal(a.status,'queued');
  assert.equal((await client`SELECT started_at FROM loop_runs WHERE id=${a.loopRunId}`)[0].started_at,null);
  assert.equal((await client`SELECT count(*)::int AS n FROM workshop_events WHERE workshop_id=${workId} AND type='loop_execution_accepted'`)[0].n,1);
  await assert.rejects(acceptWorkLoopExecution({...command,commandId:randomUUID()}),{code:'target_busy'});
  await assert.rejects(acceptWorkLoopExecution({...command,mode:'native_agent'}),{code:'payload_conflict'});
  assert.deepEqual(await consumeOwnedWorkRuns({userId,workerId:'ordinary-consumer'},async()=>{throw Error('Loop must not run as an ordinary Work model');}),[]);
  return {name:'Loop acceptance: atomic linked runs/event, stable command replay, active exclusion and no ordinary consumer misrouting',passed:true};
}
