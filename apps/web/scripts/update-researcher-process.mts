import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import YAML from 'yaml';
const base='http://127.0.0.1:3515',id='cec5143f-567b-453d-9d18-4ad90d193572',loopId='2cf7ef58-3349-4e6c-b54f-80d91b107d70';
const folder=resolve('.tmp/researcher-process-update-20261002');mkdirSync(folder,{recursive:true});
const memoryId='33e1fb66-b0e2-4da4-9650-66bff13c9cb2';
async function api(path:string,body?:unknown,method='POST'){
 const response=await fetch(base+path,body?{method,headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify(body)}:undefined);
 const data=await response.json();if(!response.ok)throw Error(JSON.stringify({status:response.status,data}));return data;
}
function save(name:string,value:unknown){writeFileSync(resolve(folder,name),typeof value==='string'?value:JSON.stringify(value,null,2),'utf8');}
function utf8(value:unknown){if(/\uFFFD|\?{3}/u.test(typeof value==='string'?value:JSON.stringify(value)))throw Error('Encoding readback mismatch');}
const correction='2026-10-02 主人纠错：记忆 '+memoryId+' 中“report-quality-evaluator 仅检查格式”缺少当前源码支持；实际实现存在 LLM 证据/因果质量评审，并有模型失败后的规则兜底。09:00 run 724f833f-acef-8cd8-a3e7-9809e3eb8ffe 的 quality_review 事件 d42fe36b-04a3-44e2-9f1f-9ca6a02bb219 确实是模型约45秒超时后 rule_based=100，不代表语义评审已完成。旧记忆有限两次搜索和一篇二手正文不能证明最近七天无新论文或整个相关机制未变化；旧未核判断按 pending_verification 处理，不重新写成事实。以 repo/apps/web/lib/work-evolution/report-quality-evaluator.ts、repo/apps/web/lib/loops/verifier.ts 当前真实读取及实际事件为依据。已授权 Read/Glob/Grep 整库只读，不能因旧记忆继续声称权限缺失。保存修正前按 oldMemoryId+correctedClaim 查重，保留原文及反证；研究员不能自行改原始事件或配置。';
const phase=process.argv[2];
if(phase==='prepare'){
 const before=await api(`/api/workshops/${id}/manifest`);save('manifest-preapply.json',before);save('before.yaml',before.manifestYaml);
 const manifest=YAML.parse(before.manifestYaml),loop=manifest.spec.loops.find((l:any)=>l.name==='agent-frontier-study');
 manifest.spec.modelConfig.researchRoleVersion='2.2.0';
 manifest.spec.modelConfig.workVersion=new Date().toISOString();
 loop.goal='围绕一个知遇真实问题完成源码与一手资料核验，最多交付一个有证据的判断；不足如实披露，保存纠错和下一轮状态，有价值再汇报。';
 const files=['docs/architecture/zhiyu-project-research-map.md','docs/architecture/engineering-cybernetics-guiding-principles.md','docs/reviews/researcher-latest-process-audit-2026-10-02.md'];
 const fileSources=files.map(path=>({name:'zhiyu-research-v3:'+path,type:'file',uri:resolve('../..',path),purpose:'导航与审计线索，不能代替当前 repo/ 源码读取。',freshnessPolicy:'per_run_content_hash',manifestSourceType:'file'}));
 const remaining=loop.context.sources.filter((s:any)=>s.type!=='file');
 loop.context.sources=[...remaining,...fileSources.map(({name,type,uri})=>({name,type,uri}))];
 loop.context.instructions='按 agent-frontier-research 2.2.0 依次选一个问题、Grep 符号、Read 两份有关 repo/ 源码、定向搜索与读取一手资料、纠错并保存下轮状态。登记副本只作导航，源码使用已授权整库只读入口。每份 sourceEvidence 必须填工具返回的真实 path/sha256/startLine/endLine，独立验收按实际回执核对。研究不足或工具降级时明示 researchProcess.status、gaps 和下一步；可安静交付，不编造无变化、测试和价值。通知依据在 projectAssessment.notificationReason 中说明。遵守现有 denied 边界，不执行 shell、修改源码、配置或外发。报告与记忆下一轮窗口一致；用户可在本车间查看、纠正或暂停。';
 loop.verification.requiredFields=[...new Set([...loop.verification.requiredFields,'researchProcess'])];
 loop.verification.requiredSources=['Read']; // External failure may still be delivered with explicit gaps.
 loop.verification.successCriteria=[
  'sufficient 必须有成功 Grep、两份不同 repo 源码真实哈希与行范围、定向 webSearch 和一手正文回执；独立验收不信自报。',
  '证据不足或工具降级明确缺口和下一步，不冒充全行业无变化；有实证纠错、阻塞或决策需求可明确理由汇报。',
  '区分源码观察、作者主张、实际测试和推断，最多一个机会；状态保存以真实回执为准。',
 ];
 manifest.spec.sources=[...manifest.spec.sources.filter((s:any)=>s.type!=='file'),...fileSources];
 const candidate=YAML.stringify(manifest);utf8(candidate);save('candidate.yaml',candidate);
 const dry=await api(`/api/workshops/${id}`,{manifestYaml:candidate,dryRun:true},'PATCH');save('dry-run.json',dry);if(!dry.review.ok)throw Error(JSON.stringify(dry.review.issues));
 console.log(JSON.stringify({ready:true,expectedVersion:before.commandVersion,stagedFiles:3,version:'2.2.0'}));
}else if(phase==='apply'){
 const before=JSON.parse(readFileSync(resolve(folder,'manifest-preapply.json'),'utf8')),candidate=readFileSync(resolve(folder,'candidate.yaml'),'utf8');
 const receipt=await api(`/api/workshops/${id}`,{manifestYaml:candidate,expectedVersion:before.commandVersion,commandId:`researcher-process-v220:${before.commandVersion}`},'PATCH');save('apply-receipt.json',receipt);
 const after=await api(`/api/workshops/${id}/manifest`);save('manifest-after.json',after);save('after.yaml',after.manifestYaml);utf8(after.manifestYaml);
 const loaded=YAML.parse(after.manifestYaml),loop=loaded.spec.loops.find((l:any)=>l.name==='agent-frontier-study');
 if(loaded.spec.modelConfig.researchRoleVersion!=='2.2.0'||!loop.verification.requiredFields.includes('researchProcess')||loop.context.sources.filter((s:any)=>s.type==='file').length!==3)throw Error('Loaded config mismatch');
 const template=resolve('../../manifests/workshops/agent-frontier-researcher.workshop.yaml');writeFileSync(template,candidate,'utf8');utf8(readFileSync(template,'utf8'));
 console.log(JSON.stringify({saved:true,version:after.commandVersion,processGate:loop.verification.requiredFields.includes('researchProcess'),codebaseRead:loaded.spec.modelConfig.codebaseRead}));
}else if(phase==='correct'){
 const receipt=await api(`/api/brain/candidates/${memoryId}/review`,{decision:'weakened',reason:correction});save('memory-review-receipt.json',receipt);
 const reviews=await api(`/api/brain/reviews?memoryId=${memoryId}`);save('memory-review-readback.json',reviews);utf8(reviews);
 const directive=await api(`/api/workshops/${id}/commands`,{command:'addWorkDirective',commandId:'researcher-process-correction-v220-20261002',scope:'persistent',triggerRun:false,reason:'主人授权更新研究员流程，纠正真实审计发现。',content:correction});save('correction-directive-receipt.json',directive);
 const directives=await api(`/api/workshops/${id}/directives`);save('directives-after.json',directives);utf8(directives);if(!JSON.stringify(directives).includes('旧记忆有限两次搜索'))throw Error('Correction readback mismatch');
 const memories=await api(`/api/workshops/${id}/memories`);save('memories-after-correction.json',memories);
 console.log(JSON.stringify({reviewed:true,correctionSaved:true,readbackChecked:true}));
}else if(phase==='start'){
 const directive=await api(`/api/workshops/${id}/commands`,{command:'addWorkDirective',commandId:'researcher-process-v220-matched-trial-20261002',scope:'current_run',triggerRun:false,reason:'修改后的针对性过程验收，不作为持续研究唯一选题。',content:'本轮针对性验收沿用09:00选题：知遇对语义失败和评审降级的观测是否充分，外部一手评估方法有什么可验证增量？先用当前整库只读工具核查 report-quality-evaluator 及调用/验证链路，再做有域名或时间窗的外部检索和一手正文读取。核对旧 memoryId=33e1fb66-b0e2-4da4-9650-66bff13c9cb2 的不准确断言，按已读证据保存纠错与下一轮状态。目标是实际执行新流程，不是输出高分；允许 evidence_insufficient/degraded，给具体缺口，不执行代码修改、shell、测试或外发。未来日常轮次仍自行选择项目问题。'});save('trial-directive.json',directive);
 const receipt=await api(`/api/workshops/${id}/loops/${loopId}/execute`,{commandId:'researcher-process-v220-native-trial-20261002',mode:'native_agent',wait:false,createOutboxDrafts:false});save('trial-enqueue.json',receipt);console.log(JSON.stringify(receipt));
}else if(phase==='amend'){
 const before=await api(`/api/workshops/${id}/manifest`);save('amend-before.json',before);
 const manifest=YAML.parse(before.manifestYaml),loop=manifest.spec.loops.find((l:any)=>l.name==='agent-frontier-study');
 manifest.spec.modelConfig.researchRoleVersion='2.2.1';manifest.spec.modelConfig.workVersion=new Date().toISOString();
 loop.context.instructions=loop.context.instructions.replace('2.2.0','2.2.1');
 const candidate=YAML.stringify(manifest);save('amend-candidate.yaml',candidate);
 const dry=await api(`/api/workshops/${id}`,{manifestYaml:candidate,dryRun:true},'PATCH');if(!dry.review.ok)throw Error(JSON.stringify(dry.review.issues));
 save('amend-receipt.json',await api(`/api/workshops/${id}`,{manifestYaml:candidate,expectedVersion:before.commandVersion,commandId:`researcher-process-v221:${before.commandVersion}`},'PATCH'));
 const after=await api(`/api/workshops/${id}/manifest`);utf8(after.manifestYaml);save('amend-after.json',after);
 if(YAML.parse(after.manifestYaml).spec.modelConfig.researchRoleVersion!=='2.2.1')throw Error('Version readback mismatch');
 const templatePath=resolve('../../manifests/workshops/agent-frontier-researcher.workshop.yaml'),template=YAML.parse(readFileSync(templatePath,'utf8'));template.spec.modelConfig.researchRoleVersion='2.2.1';template.spec.modelConfig.workVersion=manifest.spec.modelConfig.workVersion;template.spec.loops[0].context.instructions=loop.context.instructions;writeFileSync(templatePath,YAML.stringify(template),'utf8');
 const trialMemoryId='8719661f-cde3-45b6-818c-0d936eb40913';
 const reason='第八轮验收保留失败证据：实际工具回执已读 report-quality-evaluator.ts 750-877行，不能说未读；PyPI新旧版本/发布日期未核全，不能宣称已确认最新版本。该轮Grep/Glob确实被平台边界桥误分类为外部写入并denied，不是研究员违背权限；工程侧现已修复观察分类，须按下一轮实际有效边界与调用回执重新核验。旧deny是历史状态，不可推广到下一轮。';
 save('trial-memory-review.json',await api(`/api/brain/candidates/${trialMemoryId}/review`,{decision:'weakened',reason}));
 save('trial-correction-directive.json',await api(`/api/workshops/${id}/commands`,{command:'addWorkDirective',commandId:'researcher-process-v221-trial-correction-20261002',scope:'persistent',triggerRun:false,reason:'验收定位平台分类错误与报告范围失真，保留原文并补充反证。',content:reason}));
 save('amend-directives-readback.json',await api(`/api/workshops/${id}/directives`));
 console.log(JSON.stringify({saved:true,version:after.commandVersion,roleVersion:'2.2.1',firstTrialMemoryReviewed:true}));
}else if(phase==='retry'){
 save('retry-directive.json',await api(`/api/workshops/${id}/commands`,{command:'addWorkDirective',commandId:'researcher-process-v221-matched-trial-20261002',scope:'current_run',triggerRun:false,reason:'修复只读工具误分类后的有限重验。',content:'本轮重验同一问题：知遇对语义失败和评审降级的观测是否充分，外部一手评估方法有什么增量？工程側已补齐Loop的Read/Glob/Grep只读分类；仍以本轮有效policy与真实回执为准。先Grep enqueueLoopReportQualityEvaluation（pattern apps/web/**/*.ts），按搜索结果Read实现及真正调用者核心范围，不用猜目录。再定向webSearch，webReadPage优先直接读取官方文档（preferReader=false）。需要正文失败、版本或redirect不明确则标明evidence_insufficient和缺口，不硬造充分。旧报告内容只作线索；最终哈希、已读行范围、来源版本及下一轮窗口逐项核对回执；纠错按oldMemoryId+correctedClaim查重。记录本轮新增事实与状态，不能将整篇报告堆成记忆。不执行shell、测试、改代码或外发。'}));
 const receipt=await api(`/api/workshops/${id}/loops/${loopId}/execute`,{commandId:'researcher-process-v221-native-trial-20261002',mode:'native_agent',wait:false,createOutboxDrafts:false});save('retry-enqueue.json',receipt);console.log(JSON.stringify(receipt));
}else if(phase==='finalize'){
 const before=await api(`/api/workshops/${id}/manifest`);save('final-before.json',before);
 const manifest=YAML.parse(before.manifestYaml),loop=manifest.spec.loops.find((l:any)=>l.name==='agent-frontier-study');
 manifest.spec.modelConfig.researchRoleVersion='2.2.2';manifest.spec.modelConfig.workVersion=new Date().toISOString();loop.context.instructions=loop.context.instructions.replace('2.2.1','2.2.2');
 const candidate=YAML.stringify(manifest);save('final-candidate.yaml',candidate);utf8(candidate);
 const dry=await api(`/api/workshops/${id}`,{manifestYaml:candidate,dryRun:true},'PATCH');save('final-dry-run.json',dry);if(!dry.review.ok)throw Error(JSON.stringify(dry.review.issues));
 save('final-receipt.json',await api(`/api/workshops/${id}`,{manifestYaml:candidate,expectedVersion:before.commandVersion,commandId:`researcher-process-v222:${before.commandVersion}`},'PATCH'));
 const after=await api(`/api/workshops/${id}/manifest`);save('final-manifest-readback.json',after);utf8(after.manifestYaml);if(YAML.parse(after.manifestYaml).spec.modelConfig.researchRoleVersion!=='2.2.2')throw Error('Final version mismatch');
 const templatePath=resolve('../../manifests/workshops/agent-frontier-researcher.workshop.yaml'),template=YAML.parse(readFileSync(templatePath,'utf8'));template.spec.modelConfig.researchRoleVersion='2.2.2';template.spec.modelConfig.workVersion=manifest.spec.modelConfig.workVersion;template.spec.loops[0].context.instructions=loop.context.instructions;writeFileSync(templatePath,YAML.stringify(template),'utf8');
 const ninthMemory='ea078fdc-2a19-40e3-94af-bed9b0c79854';
 const reason='第九轮过程纠错（保留原文与失败回执）：两篇论文的实际已读窗口是15000/12000字符，总长度约93K/61K不是全文已读；读取次数以Trace为准。草稿创建290-299与return路径属于loop-runtime.ts，不是report-quality-evaluator.ts。源码仅证明该已读调用点未使用评审返回值改变其返回/此前草稿创建，未核全通知、调度和实际外发，不能断言所有下游都无约束。语义评审未完成是unknown，不等于已违反准则或安全审计检测到了攻击。论文中少于20行、四倍收益是作者特定攻击实验主张，不能作为知遇改动成本或收益事实。报告尾部限制、真实读取范围、scope和复查条件须同步到记忆；本轮Grep权限修复与调用者发现已真实验证，但Loop验收仍blocked。日期未知应省略或空值，不编造；仅年号/arXiv关键词不满足定向检索，使用site:官方域或明确日期窗。网页finalUrlVerified=false时明示重定向未核验，不能自报充分。';
 save('ninth-memory-review.json',await api(`/api/brain/candidates/${ninthMemory}/review`,{decision:'weakened',reason}));
 save('ninth-correction-directive.json',await api(`/api/workshops/${id}/commands`,{command:'addWorkDirective',commandId:'researcher-process-v222-ninth-correction-20261002',scope:'persistent',triggerRun:false,reason:'真实过程验收后的边界与读取范围纠正。',content:reason}));
 const directives=await api(`/api/workshops/${id}/directives`);utf8(directives);save('final-directives-readback.json',directives);if(!JSON.stringify(directives).includes('总长度约93K/61K不是全文已读'))throw Error('Final feedback not saved');
 const memories=await api(`/api/workshops/${id}/memories`);save('final-memories-readback.json',memories);utf8(memories);
 const list=Array.isArray(memories)?memories:memories.memories??[];if(list.find((m:any)=>m.id===ninthMemory)?.status!=='weakened')throw Error('Final memory review mismatch');
 console.log(JSON.stringify({saved:true,roleVersion:'2.2.2',configurationVersion:after.commandVersion,memoryStatus:'weakened',feedbackReadbackChecked:true,noThirdTrial:true}));
}else if(phase==='probe'){
 const {config}=await import('dotenv');config({path:'.env.local',quiet:true});config({path:'.env',quiet:true});
 const {getWorkshop}=await import('../lib/workshops/service');const {getLoop}=await import('../lib/loops/service');
 const {loadWorkshopRunSkills}=await import('../lib/workshops/run-prompt-skills');const {workshopBoundaryToLoopPolicies}=await import('../lib/workshops/boundary-policy');
 const work=await getWorkshop('dcb1985e-3fe2-42fd-8978-7b04d1772850',id),loop=await getLoop('dcb1985e-3fe2-42fd-8978-7b04d1772850',loopId);if(!work||loop?.workshopId!==id)throw Error('Owner scope unavailable');
 const skills=loadWorkshopRunSkills(work,loop.name).map(s=>({name:s.name,version:s.version,status:s.status,source:s.source}));
 const bridge=workshopBoundaryToLoopPolicies({workshop:work,actionPolicy:loop.actionPolicy,approvalPolicy:loop.approvalPolicy});
 if(!skills.some(s=>s.name==='agent-frontier-research'&&s.version==='2.2.2'&&s.status==='loaded'))throw Error('Skill loader mismatch');
 const denied=(bridge.actionPolicy.denied??[]) as string[];if(denied.some(t=>['grep','glob'].includes(t.toLowerCase())))throw Error('Observation classification regression');
 const result={probeOnly:true,modelRun:false,loopStatus:loop.status,skills,effectiveAllowed:bridge.actionPolicy.allowed,effectiveDenied:denied,boundary:bridge.metadata};save('final-loader-and-boundary-probe.json',result);console.log(JSON.stringify(result));process.exit(0);
}else if(phase==='evidence'){
 const {config}=await import('dotenv');config({path:'.env.local',quiet:true});config({path:'.env',quiet:true});
 const {getLoop,listLoopRuns}=await import('../lib/loops/service');
 const loop=await getLoop('dcb1985e-3fe2-42fd-8978-7b04d1772850',loopId);if(loop?.workshopId!==id)throw Error('Owner scope mismatch');
 const runs=await listLoopRuns(loopId,{limit:20});const target=process.argv[3]??JSON.parse(readFileSync(resolve(folder,'trial-detail.json'),'utf8')).loop.latestRun.id;
 const run=runs.find((r:any)=>r.id===target);if(!run)throw Error('Run not found');save(`result-${target}.json`,run);
 const {db}=await import('../lib/db');const {sql}=await import('drizzle-orm');
 const rows=await db.execute(sql`SELECT x.result_json FROM workshop_loop_executions x JOIN workshops w ON w.id=x.workshop_id WHERE x.run_id=${target}::uuid AND x.loop_id=${loopId}::uuid AND w.id=${id}::uuid AND w.user_id=${'dcb1985e-3fe2-42fd-8978-7b04d1772850'}::uuid`);
 if(!rows[0]?.result_json)throw Error('Captured native result unavailable');save(`captured-${target}.json`,rows[0].result_json);
 const verification=run.verificationResult as any;
 console.log(JSON.stringify({runId:run.id,status:run.status,verificationPassed:verification?.passed,issues:verification?.checker?.issues,verificationKeys:Object.keys(verification??{})},null,2));
 process.exit(0);
}else if(phase==='recheck'){
 const target=process.argv[3]??'977b1ea2-8919-8407-af64-0ae83722f79f';
 const captured=JSON.parse(readFileSync(resolve(folder,`captured-${target}.json`),'utf8'));
 const {verifyLoopRun}=await import('../lib/loops/verifier');
 const config=YAML.parse(JSON.parse(readFileSync(resolve(folder,'amend-after.json'),'utf8')).manifestYaml).spec.loops[0].verification;
 const result=verifyLoopRun({verificationConfig:config,result:captured});save(`offline-recheck-${target}.json`,{historicalRunStatus:'blocked',recomputedOnly:true,...result});
 console.log(JSON.stringify({recomputedOnly:true,passed:result.passed,issues:result.issues},null,2));
}else if(phase==='inspect'){
 const detail=await api(`/api/workshops/${id}/loops/${loopId}/detail`);save('trial-detail.json',detail);
 const run=detail.loop?.latestRun;if(!run){console.log('No run');process.exit(0);}
 const events=await api(`/api/workshops/${id}/events?runId=${run.id}&limit=2000`);save('trial-events.json',events);
 const actualEvents=Array.isArray(events)?events:events.events??[];
 const calls=actualEvents.filter((e:any)=>e.type==='tool_call');const counts:Record<string,number>={};for(const e of calls){const name=e.metadata?.toolName??e.title;counts[name]=(counts[name]??0)+1;}
 console.log(JSON.stringify({runId:run.id,status:run.status,verificationPassed:run.verificationPassed,startedAt:run.startedAt,completedAt:run.completedAt,error:run.error,toolCounts:counts,lastCalls:calls.slice(-3).map((e:any)=>({name:e.metadata?.toolName,input:e.metadata?.toolInput??e.body?.slice(0,200)})),tail:actualEvents.slice(-2).map((e:any)=>({type:e.type,title:e.title,body:e.body?.slice(0,400)}))},null,2));
}else throw Error('Expected prepare/apply/correct/start/inspect');
