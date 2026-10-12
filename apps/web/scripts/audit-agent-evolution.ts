import {config} from 'dotenv';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
config({path:'.env.local',quiet:true});config({path:'.env',quiet:true});
async function main(){
 const {db}=await import('@/lib/db/client');const {sql}=await import('drizzle-orm');const {closeDb}=await import('@/lib/db/adapters');
 try {
  const owners=await db.execute(sql`SELECT user_id FROM workshops WHERE id='44861dfc-916f-431f-899b-364ca54f0aa1'::uuid`);
  const owner=owners[0]?.user_id as string;if(!owner)throw Error('Owner not found');
  const {listWorkshops}=await import('@/lib/workshops/service');const {exportWorkshopManifest}=await import('@/lib/workshops/manifest-export');
  const {listLoopsForWorkshop}=await import('@/lib/loops/service');const {loadSkills}=await import('@/lib/ai/skills/loader');
  const skills=loadSkills();const works=await listWorkshops(owner,1000);const items=[];
  for(const w of works){
   const config=w.modelConfig as any;
   const loops=await listLoopsForWorkshop({userId:owner,workshopId:w.id});
   const runs=await db.execute(sql`SELECT id,status,error,created_at FROM workshop_runs WHERE workshop_id=${w.id}::uuid ORDER BY created_at DESC LIMIT 10`);
   const loopRuns=await db.execute(sql`SELECT r.id,r.status,r.verification_result,r.created_at FROM loop_runs r JOIN loops l ON l.id=r.loop_id WHERE l.workshop_id=${w.id}::uuid ORDER BY r.created_at DESC LIMIT 5`);
   const exported=await exportWorkshopManifest(owner,w.id);
   const assigned=[...new Set([...(config.primarySkills??[]),...Object.values(config.loopSkillMap??{})])];
   const skillItems=assigned.map(name=>{const skill=skills.find(s=>s.name===name);return{name,path:skill?.path,content:skill?readFileSync(join(skill.path,'SKILL.md'),'utf8'):null};});
   items.push({id:w.id,name:w.name,status:w.status,version:exported?.commandVersion,mission:w.mission,role:config.role,autonomy:w.autonomyLevel,boundary:w.boundaryPolicy,allowedTools:config.allowedTools,requiresApprovalTools:config.requiresApprovalTools,disallowedTools:config.disallowedTools,skills:skillItems,loops:loops.map(l=>({id:l.id,name:l.name,status:l.status,goal:l.goal,context:l.contextConfig,verification:l.verificationConfig,actionPolicy:l.actionPolicy})),runs,loopRuns});
  }
  const root=resolve('../../.runtime/agent-evolution-2026-10-01');mkdirSync(root,{recursive:true});
  writeFileSync(resolve(root,'inventory.json'),JSON.stringify({observedAt:new Date().toISOString(),items},null,2),'utf8');
  console.log(JSON.stringify({inventoryPath:resolve(root,'inventory.json'),count:items.length,items:items.map(w=>({id:w.id,name:w.name,status:w.status,version:w.version,missionChars:w.mission.length,skillCount:w.skills.length,missingSkills:w.skills.filter(s=>!s.content).map(s=>s.name),loopCount:w.loops.length,recentRunStatuses:w.runs.map((r:{status:string})=>r.status)}))},null,2));
 }finally{await closeDb();}
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
