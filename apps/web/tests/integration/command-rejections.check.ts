import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import type postgres from 'postgres';
import {acceptLocalWorkCommand,executeLocalWorkCommand,getWorkCommand,prepareLocalWorkCommand,WorkCommandConflict} from '@/lib/work-runtime/command-ledger';
import {subscribeWorkshopEvents} from '@/lib/workshops/event-bus';
import {updateWork} from '@/lib/work-runtime/commands';
import {applyWorkshopManifestToExisting} from '@/lib/workshops/manifest';
import {getWorkshopConfigurationBaseline} from '@/lib/workshops/service';

export async function checkCommandRejections(client: postgres.Sql) {
  const owner=randomUUID(),work=randomUUID();
  await client`INSERT INTO "User"(id,email) VALUES (${owner},'command-rejection@example.invalid')`;
  await client`INSERT INTO workshops(id,user_id,name,mission) VALUES (${work},${owner},'original','rejection fixture')`;
  const command={ownerId:owner,workId:work,commandId:randomUUID(),type:'fixture.rejection',expectedVersion:0,payload:{}};
  await acceptLocalWorkCommand(command);
  const delivered: string[]=[];
  const unsubscribe=subscribeWorkshopEvents(work,event=>delivered.push(event.type));
  let attempts=0;
  const reject: Parameters<typeof executeLocalWorkCommand>[3]=async (tx,_payload,append)=>{
    attempts++;
    await tx.execute(sql`UPDATE workshops SET name='must roll back' WHERE id=${work}::uuid`);
    await append({workshopId:work,type:'must_not_be_published',title:'rolled back'});
    throw new WorkCommandConflict('manifest_identity_reserved');
  };
  try {
    await client.unsafe(`CREATE FUNCTION reject_failure_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.phase='failed' THEN RAISE EXCEPTION 'injected rejection audit failure'; END IF; RETURN NEW; END $$`);
    await client.unsafe('CREATE TRIGGER reject_failure_audit BEFORE INSERT ON work_command_events FOR EACH ROW EXECUTE FUNCTION reject_failure_audit()');
    try {await assert.rejects(executeLocalWorkCommand(owner,command.commandId,command.type,reject));}
    finally {await client.unsafe('DROP TRIGGER reject_failure_audit ON work_command_events');await client.unsafe('DROP FUNCTION reject_failure_audit()');}
    assert.equal((await getWorkCommand(owner,command.commandId))?.status,'queued');assert.deepEqual(delivered,[]);
    assert.equal((await client`SELECT name FROM workshops WHERE id=${work}`)[0].name,'original');
    const [a,b]=await Promise.all([executeLocalWorkCommand(owner,command.commandId,command.type,reject),executeLocalWorkCommand(owner,command.commandId,command.type,reject)]);
    assert.deepEqual(a,b);assert.equal(a.status,'failed');assert.equal(a.errorCode,'manifest_identity_reserved');assert.equal(attempts,2);
    assert.deepEqual(delivered,['work_command_failed']);
    assert.equal((await client`SELECT count(*)::int AS n FROM workshop_events WHERE workshop_id=${work} AND type='must_not_be_published'`)[0].n,0);
    assert.equal((await client`SELECT version FROM work_command_targets WHERE workshop_id=${work}`)[0].version,0);
    assert.equal((await client`SELECT count(*)::int AS n FROM work_command_events WHERE owner_id=${owner} AND command_id=${command.commandId} AND phase='failed'`)[0].n,1);
    const policy={userId:owner,workId:work,commandId:randomUUID(),expectedVersion:0,patch:{modelConfig:{manifestName:'forged'}}};
    await assert.rejects(updateWork(policy),/manifest_identity_reserved/);
    await assert.rejects(updateWork(policy),/manifest_identity_reserved/);
    assert.equal((await getWorkCommand(owner,policy.commandId))?.status,'failed');
    const invalidManifest={userId:owner,workshopId:work,manifestYaml:'invalid: true',commandId:randomUUID(),expectedVersion:0};
    await assert.rejects(applyWorkshopManifestToExisting(invalidManifest),/invalid_command/);
    await assert.rejects(applyWorkshopManifestToExisting(invalidManifest),/invalid_command/);
    assert.equal((await getWorkCommand(owner,invalidManifest.commandId))?.status,'failed');
    const preparationRace={...command,commandId:randomUUID()};await acceptLocalWorkCommand(preparationRace);
    let rejectDraft!:()=>void,started!:()=>void;
    const ready=new Promise<void>(resolve=>{started=resolve;});
    const failing=prepareLocalWorkCommand(owner,preparationRace.commandId,async()=>{started();await new Promise<void>(resolve=>{rejectDraft=resolve;});throw new WorkCommandConflict('invalid_command');});
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {await Promise.race([ready,new Promise<never>((_,reject)=>{deadline=setTimeout(()=>reject(new Error('Preparation barrier was not reached')),5000);})]);}
    finally {if(deadline)clearTimeout(deadline);}
    await prepareLocalWorkCommand(owner,preparationRace.commandId,async()=>({winner:true}));
    rejectDraft();const winning=await failing;
    assert.equal(winning.status,'queued');assert.deepEqual(winning.preparedPayload,{winner:true});
    const transient={...command,commandId:randomUUID()};await acceptLocalWorkCommand(transient);
    await assert.rejects(executeLocalWorkCommand(owner,transient.commandId,transient.type,async tx=>{await tx.execute(sql`SELECT 1/0`);return null;}));
    assert.equal((await getWorkCommand(owner,transient.commandId))?.status,'queued');
    assert.equal((await executeLocalWorkCommand(owner,transient.commandId,transient.type,async()=>({recovered:true}))).status,'succeeded');
    const baselineWork=randomUUID();
    await client`INSERT INTO workshops(id,user_id,name,mission) VALUES (${baselineWork},${owner},'revision-0','paired baseline')`;
    let finished=false,readCount=0;
    const writer=(async()=>{
      try {for(let revision=1;revision<=20;revision++)await updateWork({userId:owner,workId:baselineWork,commandId:randomUUID(),expectedVersion:revision-1,patch:{name:`revision-${revision}`}});}
      finally {finished=true;}
    })();
    const reader=(async()=>{
      do {const baseline=await getWorkshopConfigurationBaseline(owner,baselineWork);assert(baseline);assert.equal(baseline.workshop.name,`revision-${baseline.commandVersion}`);readCount++;}while(!finished);
    })();
    const readsAndWrites=await Promise.allSettled([writer,reader]);
    for(const outcome of readsAndWrites)if(outcome.status==='rejected')throw outcome.reason;
    assert(readCount>1);
    assert.equal(await getWorkshopConfigurationBaseline(randomUUID(),baselineWork),null);
    return {name:'typed rejection rollback/terminal receipt; no phantom events; audit rollback; stable failure replay; preparation race; unexpected SQL retry; atomic configuration/revision read under 20 writes',passed:true,baselineReads:readCount};
  }finally{unsubscribe();}
}
