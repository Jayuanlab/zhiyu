import {config} from 'dotenv';
import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import YAML from 'yaml';
config({path:'.env.local',quiet:true});config({path:'.env',quiet:true});
async function main(){
 const {db}=await import('@/lib/db/client');const {sql}=await import('drizzle-orm');const {closeDb}=await import('@/lib/db/adapters');
 try{
  const [{getWorkshop},{listLoopsForWorkshop},{loadSkills},{loadWorkshopRunSkills},{createWorkshopPiTools},{verifyContentReview},{reviewWorkshopManifest}]=await Promise.all([
   import('@/lib/workshops/service'),import('@/lib/loops/service'),import('@/lib/ai/skills/loader'),import('@/lib/workshops/run-prompt-skills'),import('@/lib/workshops/pi-domain-tools'),import('@/lib/loops/content-review-verification'),import('@/lib/workshops/manifest'),
  ]);
  const root=resolve('../../.runtime/agent-evolution-2026-10-01');const baseline=JSON.parse(readFileSync(resolve(root,'inventory.json'),'utf8'));
  const owners=await db.execute(sql`SELECT user_id FROM workshops WHERE id='44861dfc-916f-431f-899b-364ca54f0aa1'::uuid`);const owner=owners[0].user_id as string;
  const result=[];
  for(const old of baseline.items){
   const w=await getWorkshop(owner,old.id);if(!w||!w.mission.includes('<!-- agent-evolution:v1 -->')||w.status!==old.status)throw Error(`Work readback failed: ${old.name}`);
   const loops=await listLoopsForWorkshop({userId:owner,workshopId:old.id});let loopCount=0;
   for(const l of loops){const before=old.loops.find((o:any)=>o.id===l.id);if(!before||l.status!==before.status)throw Error('Loop status mismatch');if(l.status==='archived')continue;
    if(!String(l.contextConfig.instructions).includes('<!-- agent-evolution:v1 -->'))throw Error(`Missing loop update: ${l.name}`);
    const loaded=loadWorkshopRunSkills(w,l.name);if(loaded.some(s=>s.status==='unavailable'||(s.required&&s.status!=='loaded')))throw Error(`Skill loading failed: ${l.name}: ${JSON.stringify(loaded.map(s=>({name:s.name,status:s.status})))}`);loopCount++;
   }
   let tools:string[]=[],assemblyError:string|undefined;
   const config=w.modelConfig as any;
   if(config.allowedTools?.some((name:string)=>['workshopRunComputerUse','workshopConvertDocument'].includes(name))) {
    assemblyError='Run-context-dependent tools: checked by unit tests, no live lease or execution supplied';
   }else try{tools=createWorkshopPiTools({workshop:w,workshopId:w.id,allowedTools:config.allowedTools}).map(t=>t.name);}catch(e){assemblyError=e instanceof Error?e.message:String(e);}
   result.push({name:w.name,missionLoaded:true,loopsUpdated:loopCount,statusPreserved:true,toolAssembly:assemblyError??'passed',tools});
  }
  const skills=loadSkills();const evolution=skills.find(s=>s.name==='agent-evolution');if(!evolution)throw Error('Evolution skill not discoverable');
  const repo=resolve('../../skills/agent-evolution');
  const digest=(path:string)=>createHash('sha256').update(readFileSync(path)).digest('hex');
  for(const file of ['SKILL.md','references/principles.md','references/change-contract.md','references/evaluation.md','references/zhiyu-adapter.md','agents/openai.yaml']){
    if(digest(join(repo,file))!==digest(join(evolution.path,file))||digest(join(repo,file))!==digest(join('C:/Users/96012/.codex/skills/agent-evolution',file)))throw Error(`Installed skill mismatch: ${file}`);
  }
  const manifests=[];const dir=resolve('../../manifests/workshops');
  for(const file of readdirSync(dir).filter(n=>n.endsWith('.workshop.yaml'))){
   const yaml=readFileSync(join(dir,file),'utf8');const parsed=YAML.parse(yaml);const {review}=await reviewWorkshopManifest({userId:owner,manifestYaml:yaml,existingWorkshops:[]});
   const errors=review.issues.filter(i=>i.severity==='error');manifests.push({file,updated:parsed.spec.mission.includes('<!-- agent-evolution:v1 -->'),errors});
  }
  const trial=JSON.parse(readFileSync(resolve('../../.runtime/ai-knowledge-expanded-trial-2026-10-01/3c299586-f9e9-8c4d-a419-22e2f35e752c/raw-result.json'),'utf8'));
  const replayIssues=verifyContentReview(['contentMarkdown','readerReview','sourceEvidence','discoveryCoverage'],trial.result.result.structuredReport);
  if(!replayIssues.some(i=>i.includes('placeholder'))||!replayIssues.some(i=>i.includes('both primary and secondary')))throw Error('Known false pass not rejected');
  const record={observedAt:new Date().toISOString(),result,skillPath:evolution.path,installedCopiesMatch:true,manifests,knownFalsePassReplay:{runId:trial.loopRunId,beforePassed:true,afterPassed:replayIssues.length===0,issues:replayIssues},limitations:['No new model/business runs executed','Tool assembly does not validate external services or effective per-Loop authorization','Source structure checks cannot independently establish factual truth']};
  writeFileSync(resolve(root,'verification.json'),JSON.stringify(record,null,2),'utf8');console.log(JSON.stringify(record,null,2));
 }finally{await closeDb();}
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
