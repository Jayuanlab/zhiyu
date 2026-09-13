import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type postgres from 'postgres';
import {attachSelectedEvidenceReadResults} from '@/lib/brain/service';
import type {BrainContextPack} from '@/lib/brain/context';
import {insertBrainContextLog,completeBrainEvidenceAudit,listBrainContextLogsForQuality} from '@/lib/brain/repository';
import {buildBrainRecallQualityReport} from '@/lib/brain/recall-quality';
export async function checkEvidenceQuality(client:postgres.Sql){
  const owner=randomUUID(),work=randomUUID();
  const refs=['00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002',...Array.from({length:100},()=>randomUUID())].sort();
  await client`INSERT INTO "User"(id,email) VALUES (${owner},'evidence-quality@example.invalid')`;
  await client`INSERT INTO workshops(id,user_id,name,mission) VALUES (${work},${owner},'Evidence quality','fixture')`;
  for(let n=0;n<2;n++)await client`INSERT INTO workshop_events(id,workshop_id,seq,type,title,body) VALUES (${refs[n]},${work},${n+1},'observation','Verified source','Actual source content')`;
  const pack:BrainContextPack={interfaceVersion:'brain-context.v1',selection:{selectedCount:1,deniedCount:0,omittedCount:0,duplicateCanonicalGroupCount:0,selectedCanonicalKinds:{boundary:1}},items:[{id:randomUUID(),ownerType:'work',ownerId:work,memoryType:'boundary',subject:'Safety boundary',content:'Paper only',score:100,reasons:[],evidenceRefs:refs}],denied:[],omitted:[]};
  const input={request:{requester:{type:'work' as const,userId:owner,id:work},taskIntent:'audit'},pack,routeResults:[{route:'evidence_read' as const,purpose:'evidence' as const,status:'planned' as const,reason:'audit selected sources',count:0,results:[]}]};
  const [partial]=await attachSelectedEvidenceReadResults(input);
  assert.equal(partial.status,'degraded');assert.equal(partial.results.length,102);
  assert.deepEqual({...partial.evidenceQuality,checkedAt:undefined},{requested:102,resolved:2,unresolved:98,notChecked:2,memoriesWithoutRefs:0,checkedAt:undefined});
  assert.equal(partial.results.filter(item=>item.metadata.evidenceStatus==='not_checked').length,2);
  await client`ALTER TABLE workshop_events RENAME TO evidence_fixture_events`;
  try{
    const [failed]=await attachSelectedEvidenceReadResults(input);assert.equal(failed.status,'failed');assert.equal(failed.error,'evidence_reader_unavailable');assert.equal(failed.evidenceQuality?.notChecked,102);assert.equal(failed.evidenceQuality?.resolved,0);
    assert.ok(!JSON.stringify(failed).includes('does not exist'));
  }finally{await client`ALTER TABLE evidence_fixture_events RENAME TO workshop_events`;}
  const [recovered]=await attachSelectedEvidenceReadResults(input);assert.equal(recovered.evidenceQuality?.resolved,2);
  const context=await insertBrainContextLog({requester:input.request.requester,pack,metadata:{phase:'planned',preserve:'original'}});
  const outcome={status:recovered.status,quality:recovered.evidenceQuality??null};
  const auditInput={userId:owner,contextLogId:context.id,outcome};
  await assert.rejects(completeBrainEvidenceAudit({...auditInput,userId:randomUUID()}));
  await client.unsafe(`CREATE FUNCTION reject_evidence_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected final audit failure'; END $$`);
  await client.unsafe('CREATE TRIGGER reject_evidence_audit BEFORE UPDATE ON brain_context_logs FOR EACH ROW EXECUTE FUNCTION reject_evidence_audit()');
  try{await assert.rejects(completeBrainEvidenceAudit(auditInput));}
  finally{await client.unsafe('DROP TRIGGER reject_evidence_audit ON brain_context_logs');await client.unsafe('DROP FUNCTION reject_evidence_audit()');}
  assert.equal((await client`SELECT metadata FROM brain_context_logs WHERE id=${context.id}`)[0].metadata.evidenceReadOutcome,undefined);
  await Promise.all([completeBrainEvidenceAudit(auditInput),completeBrainEvidenceAudit(auditInput)]);
  const saved=(await client`SELECT metadata FROM brain_context_logs WHERE id=${context.id}`)[0].metadata;
  assert.equal(saved.preserve,'original');assert.deepEqual(saved.evidenceReadOutcome,outcome);
  await assert.rejects(completeBrainEvidenceAudit({...auditInput,outcome:{status:'executed'}}));
  assert.deepEqual((await client`SELECT metadata FROM brain_context_logs WHERE id=${context.id}`)[0].metadata,saved);
  await insertBrainContextLog({requester:input.request.requester,pack,metadata:{legacy:true}});
  const logs=await listBrainContextLogsForQuality({userId:owner,limit:10});
  const report=buildBrainRecallQualityReport({logs,feedback:[]});
  assert.equal(report.evidenceQuality.sampledRecallCount,2);assert.equal(report.evidenceQuality.auditedRecallCount,1);assert.equal(report.evidenceQuality.missingAuditCount,1);
  assert.equal(report.evidenceQuality.requestedReferences,102);assert.equal(report.evidenceQuality.resolvedReferences,2);assert.equal(report.evidenceQuality.resolvedReferenceRate,2/102);
  assert.ok(!JSON.stringify(report).includes('Actual source content'));
  return {name:'evidence quality exposes resolution cap, missing sources, database failure and recovery',passed:true,requested:102,resolved:2,unresolved:98,notChecked:2,readerFailureExplicit:true,recovered:true,finalAuditPersisted:true,auditOwnerIsolation:true,concurrentReplay:true,auditFailureAtomic:true,conflictingRewriteDenied:true,persistedAuditFeedsQualityReport:true,legacyAuditNotCountedAsSuccess:true};
}
