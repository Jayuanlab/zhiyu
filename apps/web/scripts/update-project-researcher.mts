import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import YAML from 'yaml';
const base='http://127.0.0.1:3515',id='cec5143f-567b-453d-9d18-4ad90d193572';
const folder=resolve('.tmp/agent-frontier-role-20261002');mkdirSync(folder,{recursive:true});
async function api(path:string,body?:unknown,method='POST'){
 const r=await fetch(base+path,body?{method,headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify(body)}:undefined);
 const d=await r.json();if(!r.ok)throw Error(JSON.stringify({status:r.status,data:d}));return d;
}
const sourcePaths=[
 'docs/architecture/zhiyu-project-research-map.md',
 'docs/architecture/engineering-cybernetics-guiding-principles.md',
 'docs/architecture/zhiyu-control-architecture-contract.md',
 'docs/architecture/workshop-work-presentation.md',
 'docs/architecture/workshop-temporary-conversation.md',
 'docs/reviews/agent-frontier-rir-source-rerun-2026-10-02.md',
 'apps/web/lib/work-runtime/execution-lease.ts',
 'apps/web/lib/work-runtime/loop-execution.ts',
 'apps/web/lib/work-runtime/loop-consumer.ts',
 'apps/web/lib/work-runtime/loop-control-state.ts',
 'apps/web/lib/work-runtime/recorded-step.ts',
 'apps/web/lib/work-runtime/run-completion.ts',
 'apps/web/lib/work-runtime/runtime-snapshot.ts',
 'apps/web/lib/loops/native-executor.ts',
 'apps/web/lib/loops/harness.ts',
 'apps/web/lib/loops/verifier.ts',
 'apps/web/lib/loops/context-window.ts',
 'apps/web/lib/loops/tool-gate.ts',
 'apps/web/lib/workshops/pi-local-tools.ts',
 'apps/web/lib/workshops/pi-domain-tools.ts',
 'apps/web/lib/workshops/memory-context.ts',
];
const mission=`作为知遇项目的长期技术研究员，理解主人目标、项目架构、当前实现和真实问题，持续从外部一手知识中寻找能帮助项目推进的机会。
维护带源码版本与证据的项目认知、研究问题、机会状态和主人反馈；发现源码变化或旧结论错误时重新核验。
每天检查外部变化，优先围绕知遇桌面 Web 与必要后端的真实问题选题，不强制追逐新论文。
只在新的可行动机会、重要风险或需要决策时交付简洁判断：有什么用、当前是否需要、最小下一步、成本风险和证据缺口；无有用增量保留内部检查点。
按 agent-frontier-research Skill 区分设计、实现、实测和推断，禁止编造源码引用或以模型自评证明价值。
仅研究、记录本 Work 知识并提出建议；不得自动修改代码、配置、权限或外发。建议是否采纳以及实验是否执行由主人决定。`;
const instructions=`先读取本 Work 检查点与主人反馈，再 Read inputs/index.json，使用本轮索引的相对 inputs/文件名读取项目研究地图、已知纠错和相关源码；不要猜绝对路径。
每天检查最近七天外部一手来源，根据项目问题选择最多两个深入候选；外部知识与当前源码逐项匹配。
项目依据使用当前运行副本 SHA-256；文件更新后旧判断重验。按问题选读，不每天通读全部文件；未读依赖标为未知。
报告开头直接给有价值的判断，最多两个机会，说明项目问题、增量、是否现在值得做、最小验证及成本风险。主报告约 800–1400 字。
在 projectAssessment 记录 materialChange、notificationIntent、稳定 opportunityId 及下一步。无有用增量 notificationIntent=quiet，只留简短内部检查记录；失败明示 degraded。
读取研究地图中记录的 RIR 误判反例；事件不等于语义记忆、租约接管可能复用同一 runId、recorded-step 不等于完整环境检查点。
通过本 Work 记忆保存带来源的项目认知、机会状态与下轮问题，必须有真实写入回执。不得把字段齐全、completed 或论文分数当成业务效果证明。`;
function revise(m:any){
 const s=m.spec;m.metadata.title='知遇技术研究员';
 s.mission=mission;
 s.control={...s.control,object:'zhiyu_project_understanding_and_research_opportunities',objective:'evidence_backed_project_decisions',mode:'observe_project_research_assess_record_feedback',feedback:['owner_priorities','owner_adoption_rejection_corrections','source_version_changes','matched_experiment_outcomes']};
 s.modelConfig={...s.modelConfig,primarySkills:['agent-frontier-research'],loopSkillMap:{'项目理解与技术机会':'agent-frontier-research'},researchRoleVersion:'2.0.0',researchNotificationPolicy:'meaningful_changes_only'};
 s.sources=(s.sources??[]).filter((x:any)=>!x.name?.startsWith('zhiyu-source:'));
 for(const p of sourcePaths){
  const uri=resolve('../..',p);if(!existsSync(uri))throw Error('Missing source '+p);
  s.sources.push({name:'zhiyu-source:'+p,type:'file',uri,purpose:'主人授权的持续项目研究资料；每轮以系统副本 SHA-256 和实际读取范围为依据。文件更新允许进入新轮，不继承旧版本判断。',freshnessPolicy:'per_run_content_hash'});
 }
 for(const l of s.loops){
  if(l.name!=='agent-frontier-study')continue;
  l.title='项目理解与技术机会';l.description='维护项目认知，持续对照外部新知识，只在有决策价值时交付机会或风险简报。';
  l.goal='围绕知遇真实问题完成项目核验与外部研究，最多交付两个有证据的判断，维护机会状态和下轮检查点；没有有用增量不制造报告。';
  l.trigger={type:'cron',expression:'0 9 * * *',timezone:'Asia/Shanghai'};
  l.context={...l.context,instructions,sources:(l.context.sources??[]).filter((x:any)=>!x.name?.startsWith('zhiyu-source:'))};
  l.context.sources.push(...s.sources.filter((x:any)=>x.type==='file').map((x:any)=>({type:'file',name:x.name,uri:x.uri})));
  l.verification.successCriteria=[
   '实际读取相关项目副本和外部一手来源，项目判断能追溯函数与 SHA-256；未覆盖明确未知。',
   '结论说明项目问题、外部增量、当前优先级与最小下一步，最多两个机会，不重复已驳回建议。',
   '区分设计、实现、作者主张、真实运行与推断；不得编造行号或泛化未发现结论。',
   '正文完整，experimentProposal 无完整方案时为 null，记忆保存以真实回执为准。',
   '无有用增量记录 quiet 检查点，来源失败披露缺口；不得以结构检查替代价值和事实核验。',
  ];
 }
 s.creationReport={title:'知遇技术研究员 v2',body:'每天 09:00（Asia/Shanghai）检查项目与外部知识，仅在有用增量时产生决策简报。角色和来源通过主人版本化命令更新；实际调度、源码读取、记忆和报告行为需单独验证。'};
 return m;
}
if(process.argv[2]==='apply'){
 const baseline=await api(`/api/workshops/${id}/manifest`);
 writeFileSync(resolve(folder,'before.yaml'),baseline.manifestYaml,'utf8');
 const m=YAML.parse(baseline.manifestYaml);if(m.spec.role!=='agent_frontier_researcher')throw Error('Unexpected role');
 const oldTools=JSON.stringify(m.spec.modelConfig.allowedTools),oldDenied=JSON.stringify(m.spec.boundaryPolicy.hardDeniedActions);
 const candidate=YAML.stringify(revise(m));
 if(/\uFFFD|\?{3}/u.test(candidate))throw Error('Encoding corruption');
 writeFileSync(resolve(folder,'candidate.yaml'),candidate,'utf8');
 const dry=await api(`/api/workshops/${id}`,{manifestYaml:candidate,dryRun:true},'PATCH');
 writeFileSync(resolve(folder,'review.json'),JSON.stringify(dry,null,2),'utf8');if(!dry.review.ok)throw Error(JSON.stringify(dry.review.issues));
 const receipt=await api(`/api/workshops/${id}`,{manifestYaml:candidate,expectedVersion:baseline.commandVersion,commandId:`project-researcher-v2-20261002:${baseline.commandVersion}`},'PATCH');
 writeFileSync(resolve(folder,'receipt.json'),JSON.stringify(receipt,null,2),'utf8');
 const after=await api(`/api/workshops/${id}/manifest`);writeFileSync(resolve(folder,'after.yaml'),after.manifestYaml,'utf8');
 const loaded=YAML.parse(after.manifestYaml);
 if(loaded.metadata.title!=='知遇技术研究员'||loaded.spec.mission!==mission||JSON.stringify(loaded.spec.modelConfig.allowedTools)!==oldTools||JSON.stringify(loaded.spec.boundaryPolicy.hardDeniedActions)!==oldDenied)throw Error('Readback mismatch');
 if(loaded.spec.loops.find((x:any)=>x.name==='agent-frontier-study')?.trigger?.expression!=='0 9 * * *')throw Error('Schedule missing');
 const templatePath=resolve('../../manifests/workshops/agent-frontier-researcher.workshop.yaml');
 writeFileSync(resolve(folder,'before-template.yaml'),readFileSync(templatePath));
 const template=YAML.parse(readFileSync(templatePath,'utf8'));writeFileSync(templatePath,YAML.stringify(revise(template)),'utf8');
 const skill=readFileSync(resolve('../../skills/agent-frontier-research/SKILL.md'),'utf8');
 const skillHash=createHash('sha256').update(skill).digest('hex');
 writeFileSync(resolve(folder,'applied-summary.json'),JSON.stringify({workId:id,beforeVersion:baseline.commandVersion,afterVersion:after.commandVersion,sourcePaths,skillHash},null,2),'utf8');
 console.log(JSON.stringify({beforeVersion:baseline.commandVersion,afterVersion:after.commandVersion,sourceCount:sourcePaths.length,readback:true,skillHash}));
}else if(process.argv[2]==='run'){
 const r=await api(`/api/workshops/${id}/commands`,{command:'runWorkLoop',loopId:'2cf7ef58-3349-4e6c-b54f-80d91b107d70',commandId:'project-researcher-v2-first-run-20261002',mode:'native_agent',createOutboxDrafts:false,reason:'主人授权的项目理解与持续外部研究角色更新后首轮行为验收。'});
 writeFileSync(resolve(folder,'first-run.json'),JSON.stringify(r,null,2),'utf8');console.log(JSON.stringify(r,null,2));
}else{
 const d=await api(`/api/workshops/${id}/loops/2cf7ef58-3349-4e6c-b54f-80d91b107d70/detail`);
 writeFileSync(resolve(folder,'loop-detail.json'),JSON.stringify(d,null,2),'utf8');
 const rid=d.loop?.latestRun?.id??d.loop?.stateJson?.lastLoopRunId;
 const es=(d.events??[]).filter((e:any)=>e.runId===rid||e.loopRunId===rid);
 console.log(JSON.stringify({name:d.loop?.name,phase:d.loop?.currentPhase,nextRun:d.loop?.nextScheduledRunAt,run:d.loop?.latestRun,events:es.slice(0,18).map((e:any)=>({type:e.type,title:e.title,body:e.body?.slice(0,190),sourceCount:e.metadata?.stagedFiles?.staged?.length}))},null,2));
}
