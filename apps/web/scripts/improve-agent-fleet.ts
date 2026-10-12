import {config} from 'dotenv';
import {readFileSync,writeFileSync,mkdirSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import YAML from 'yaml';
config({path:'.env.local',quiet:true});config({path:'.env',quiet:true});
const policy=JSON.parse(readFileSync(new URL('./data/agent-evolution-improvements-2026-10-01.json',import.meta.url),'utf8'));
const marker='<!-- agent-evolution:v1 -->',end='<!-- /agent-evolution -->';
function section(text:string,body:string){
 const offset=text.indexOf(marker);
 if(offset>=0){const finish=text.indexOf(end,offset);if(finish<0)throw Error('Incomplete improvement section');text=text.slice(0,offset)+text.slice(finish+end.length);}
 return `${text.trim()}\n\n${marker}\n${body}\n${end}`;
}
const mission=(original:string,p:any)=>section(original,[policy.shared,p.detail].filter(Boolean).join('\n\n'));
const instructions=(original:string,p:any)=>section(original,[policy.shared,p.loopDetail].filter(Boolean).join('\n\n'));
const canonical=(value:any):any=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const hash=(value:any)=>createHash('sha256').update(JSON.stringify(canonical(value))??'undefined').digest('hex');
async function main(){
 if(process.argv.includes('--templates')){
  const root=resolve('../../manifests/workshops');const results=[];
  for(const name of readdirSync(root).filter(n=>n.endsWith('.workshop.yaml'))){
   const path=resolve(root,name);const m=YAML.parse(readFileSync(path,'utf8'));const p=policy.workshops.find((p:any)=>p.name===m.metadata.title);if(!p)continue;
   m.spec.mission=mission(m.spec.mission,p);
   if(p.attachEvolutionSkill)m.spec.modelConfig.primarySkills=[...new Set([...(m.spec.modelConfig.primarySkills??[]),'agent-evolution'])];
   for(const l of m.spec.loops??[]){if(l.status==='archived')continue;l.context??={};l.context.instructions=instructions(l.context.instructions??'',p);}
   writeFileSync(path,YAML.stringify(m),'utf8');results.push(name);
  }
  console.log(JSON.stringify({templatesUpdated:results}));return;
 }
 const {db}=await import('@/lib/db/client');const {sql}=await import('drizzle-orm');const {closeDb}=await import('@/lib/db/adapters');
 try{
  const rows=await db.execute(sql`SELECT user_id FROM workshops WHERE id='44861dfc-916f-431f-899b-364ca54f0aa1'::uuid`);const owner=rows[0]?.user_id as string;if(!owner)throw Error('Owner missing');
  const {listWorkshops,getWorkshop,getWorkshopConfigurationBaseline,createWorkshopWorkVersionSnapshot}=await import('@/lib/workshops/service');
  const {listLoopsForWorkshop}=await import('@/lib/loops/service');const {updateWork,updateWorkLoop}=await import('@/lib/work-runtime/commands');
  const works=await listWorkshops(owner,1000);const targets=[];
  for(const p of policy.workshops){const w=works.find((w:{name:string,id:string})=>w.name===p.name);if(!w)throw Error(`Missing target: ${p.name}`);const b=await getWorkshopConfigurationBaseline(owner,w.id);if(!b)throw Error('Baseline missing');const loops=await listLoopsForWorkshop({userId:owner,workshopId:w.id});targets.push({p,b,loops});}
  if(targets.length!==works.length)throw Error('Inventory changed; analyze additional targets first');
  const root=resolve('../../.runtime/agent-evolution-2026-10-01');mkdirSync(root,{recursive:true});
  const plans=targets.map(({p,b,loops})=>({id:b.workshop.id,name:p.name,baseVersion:b.commandVersion,mission:mission(b.workshop.mission,p),loops:loops.filter(l=>l.status!=='archived').map(l=>({id:l.id,name:l.name,instructions:instructions(String(l.contextConfig.instructions??''),p)})),attachEvolutionSkill:!!p.attachEvolutionSkill}));
  writeFileSync(resolve(root,'candidate-plan.json'),JSON.stringify(plans,null,2),'utf8');
  if(!process.argv.includes('--apply')){console.log(JSON.stringify({mode:'preview',targets:plans.map(p=>({name:p.name,version:p.baseVersion,loopCount:p.loops.length,attachEvolutionSkill:p.attachEvolutionSkill}))},null,2));return;}
  const results=[];
  for(const {p,b,loops} of targets){
   const w=b.workshop;const newMission=mission(w.mission,p);const config=w.modelConfig as any;
   const newConfig={...config,...(p.modelConfigPatch??{}),...(p.additionalDeniedTools?{disallowedTools:[...new Set([...(config.disallowedTools??[]),...p.additionalDeniedTools])]}:{}),...(p.attachEvolutionSkill?{primarySkills:[...new Set([...(config.primarySkills??[]),'agent-evolution'])]}:{})};
   const snapshot=await createWorkshopWorkVersionSnapshot({workshop:w,source:'owner_requested_agent_evolution_baseline',createdBy:'owner'});
   let current=await getWorkshopConfigurationBaseline(owner,w.id);if(current?.commandVersion!==b.commandVersion)throw Error(`Concurrent change: ${w.name}`);
   if(w.mission!==newMission||hash(config)!==hash(newConfig))await updateWork({userId:owner,workId:w.id,expectedVersion:current.commandVersion,commandId:`agent-evolution:${policy.version}:${w.id}:${current.commandVersion}:mission`,source:'owner',reason:'主人要求分析改进所有智能体：补强真实证据、完整交付、状态恢复和可验证进化规则；知识管家工具收窄以符合既有角色，不增加业务动作权限。',patch:{mission:newMission,...(hash(config)!==hash(newConfig)?{modelConfig:newConfig}:{})}});
   let changedLoops=0;
   for(const loop of loops){
    if(loop.status==='archived')continue;const next=instructions(String(loop.contextConfig.instructions??''),p);if(next===loop.contextConfig.instructions)continue;
    current=await getWorkshopConfigurationBaseline(owner,w.id);
    await updateWorkLoop({userId:owner,workId:w.id,loopId:loop.id,expectedVersion:current!.commandVersion,commandId:`agent-evolution:${policy.version}:${loop.id}:${current!.commandVersion}`,source:'owner',reason:'主人授权的智能体改进：补强该任务证据、交付及恢复指引，不改变调度、审批和工具边界。',patch:{contextConfig:{...loop.contextConfig,instructions:next}}});changedLoops++;
   }
   const saved=await getWorkshop(owner,w.id);const savedLoops=await listLoopsForWorkshop({userId:owner,workshopId:w.id});const after=await getWorkshopConfigurationBaseline(owner,w.id);
   if(!saved||saved.mission!==newMission||/[\uFFFD]|\?\?\?/.test(saved.mission))throw Error(`Mission readback mismatch: ${w.name}`);
   if(saved.status!==w.status||saved.autonomyLevel!==w.autonomyLevel||hash(saved.boundaryPolicy)!==hash(w.boundaryPolicy))throw Error('Work boundary/state drift');
   const {workVersion:beforeStoredVersion,...beforeConfig}=newConfig;const {workVersion:afterStoredVersion,...afterConfig}=saved.modelConfig as any;
   if(hash(beforeConfig)!==hash(afterConfig))throw Error('Tool/runtime configuration drift');
   for(const l of savedLoops){const old=loops.find(o=>o.id===l.id);if(!old)throw Error('Unexpected loop');for(const key of ['status','triggerConfig','actionPolicy','approvalPolicy','verificationConfig','retryPolicy','escalationPolicy'] as const){if(hash(l[key])!==hash(old[key]))throw Error(`Loop control drift: ${l.name}/${key}`);}if(l.status!=='archived'&&l.contextConfig.instructions!==instructions(String(old.contextConfig.instructions??''),p))throw Error('Loop instruction readback mismatch');}
   results.push({name:w.name,id:w.id,beforeVersion:b.commandVersion,afterVersion:after?.commandVersion,changedLoops,status:saved.status,snapshotId:(snapshot as any).id});
   writeFileSync(resolve(root,'apply-results.json'),JSON.stringify({complete:false,results},null,2),'utf8');
  }
  writeFileSync(resolve(root,'apply-results.json'),JSON.stringify({complete:true,results},null,2),'utf8');console.log(JSON.stringify({complete:true,results},null,2));
 }finally{await closeDb();}
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
