import {config} from 'dotenv';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import YAML from 'yaml';
config({path:'.env.local',quiet:true}); config({path:'.env',quiet:true});
const policy=JSON.parse(readFileSync(new URL('./data/ai-content-policy-2026-10-01.json',import.meta.url),'utf8'));
const id='44861dfc-916f-431f-899b-364ca54f0aa1';
const unique=(items:string[])=>[...new Set(items)];
const suspended=(name:string)=>policy.suspendedTools.includes(name)||/^(video|douyin)/i.test(name.split('__').pop()??name);
const mission=[policy.mission,policy.discoveryInstructions].filter(Boolean).join('\n\n');
function preserveEvolution(original:string,next:string){
  const start=original.indexOf('<!-- agent-evolution:v1 -->');
  const end=original.indexOf('<!-- /agent-evolution -->',start);
  return start>=0&&end>=start&&!next.includes('<!-- agent-evolution:v1 -->')
    ? `${next}\n\n${original.slice(start,end+'<!-- /agent-evolution -->'.length)}` : next;
}
const mergeSources=(existing:any[]=[])=>{
  const sources=new Map(existing.map(source=>[source.name,source]));
  for(const source of policy.discoverySources??[]) sources.set(source.name,{...sources.get(source.name),...source});
  return [...sources.values()];
};
function transform(m:any) {
  const s=m.spec,c=s.modelConfig??={};
  s.mission=preserveEvolution(s.mission??'',mission);
  s.sources=mergeSources(s.sources);
  c.contentPillars=policy.contentPillars;
  c.contentMode='written_content_only'; c.videoMode='disabled'; c.targetPlatform='owner_review';
  c.allowedTools=unique([...(c.allowedTools??[]).filter((n:string)=>!suspended(n)),'webSearch']);
  c.observationTools=unique([...(c.observationTools??[]),'webSearch']);
  c.requiresApprovalTools=(c.requiresApprovalTools??[]).filter((n:string)=>!suspended(n));
  c.disallowedTools=unique([...(c.disallowedTools??[]),...policy.suspendedTools]);
  s.presentation={purpose:'交付读者能理解且有依据的 AI 知识内容及具体修改意见',requiredSections:['修订正文','来源与结论对应','读者审阅意见','修改摘要','待决问题'],expectedArtifacts:['中文内容修订稿','读者审阅修改记录']};
  delete c.manifestSpec;
  if(s.control) {
    s.control.object='ai_knowledge_written_content';s.control.objective='source_backed_useful_reader_reviewed_content';s.control.mode='observe_verify_write_reader_review_revise_learn';s.control.feedback=['source_freshness_and_quality','duplicate_topic_check','reader_review_findings','owner_review_outcomes','workshop_memory'];
    s.control.invariants=unique([...(s.control.invariants??[]).filter((n:string)=>!(/视频|抖音|上传|公开发布|至少一条核心来源/.test(n))),
      '至少一条核心来源必须是与论点匹配的一手材料，例如项目维护者发布说明、源码、许可证、模型卡、原始论文、当事人公告、监管原文或事故技术报告；不限定厂商规模。',
      '当前仅生产待审文字内容，禁止成片生成、平台草稿、上传和发布。']);
  }
  const b=s.boundaryPolicy??={}; b.hardDeniedActions=unique([...(b.hardDeniedActions??[]),...policy.suspendedTools]);
  b.customInstructions='当前仅允许研究、核验、写作、读者审阅和文字修订；暂停成片、素材生成、平台草稿、上传和发布。网页只作为研究证据，保留来源及限制；不公开隐私或未授权内部资料。配置改进必须主人审核。';
  for(const l of s.loops??[]) {
    if(l.status==='archived') continue;
    l.title='每日 AI 知识内容'; l.description='研究、写作、读者视角审阅并交付修订稿；暂停视频和发布。';l.goal=policy.goal;
    l.context??={}; l.context.instructions=preserveEvolution(l.context.instructions??'',[policy.instructions,policy.additionalInstructions,policy.discoveryInstructions].filter(Boolean).join('\n\n'));
    l.context.sources=mergeSources(l.context.sources).map(({purpose,...source}:any)=>source);
    l.context.metadata={...(l.context.metadata??{}),contentMode:'written_content_only',targetPlatform:'owner_review',createOutboxDraftsFromSuggestedActions:false};
    delete l.context.metadata.desiredVideoDurationSeconds;delete l.context.metadata.accountLabel;
    l.actionPolicy??={};l.actionPolicy.allowed=unique([...(l.actionPolicy.allowed??[]).filter((n:string)=>!suspended(n)),'webSearch']);l.actionPolicy.requiresApproval=(l.actionPolicy.requiresApproval??[]).filter((n:string)=>!suspended(n));l.actionPolicy.denied=unique([...(l.actionPolicy.denied??[]),...policy.suspendedTools]);
    l.verification={...(l.verification??{}),type:'structured_check',requiredFields:policy.requiredFields,successCriteria:policy.successCriteria};
    if(c.loopSkillMap) c.loopSkillMap[l.title]='ai-knowledge-creator';
  }
  s.creationReport={title:'AI 知识博主内容阶段',body:'控制对象为选题、来源、正文和审阅修订质量。来源、内容和反馈通过现有事件与记忆保留。交付待审文字内容，遇到证据缺口显式阻断。主人可审核、暂停和纠错。当前暂停视频和对外发布。',requiredFields:['sourcePolicy','contentBoundary','dailySchedule']};
  return m;
}
async function main() {
  if(process.argv.includes('--template')) {
    const path=resolve('../../manifests/workshops/ai-knowledge-creator.workshop.yaml');
    writeFileSync(path,YAML.stringify(transform(YAML.parse(readFileSync(path,'utf8')))), 'utf8');console.log('template_updated');return;
  }
  const {db}=await import('@/lib/db/client'); const {sql}=await import('drizzle-orm');const {closeDb}=await import('@/lib/db/adapters');
  try {
    const owners=await db.execute(sql`SELECT user_id FROM workshops WHERE id=${id}::uuid`);const userId=owners[0]?.user_id as string;if(!userId)throw Error('Target owner missing');
    const {exportWorkshopManifest}=await import('@/lib/workshops/manifest-export');
    const {reviewWorkshopManifest,applyWorkshopManifestToExisting}=await import('@/lib/workshops/manifest');
    const baseline=await exportWorkshopManifest(userId,id);if(!baseline)throw Error('Target missing');
    const yaml=YAML.stringify(transform(YAML.parse(baseline.manifestYaml)));
    const {review}=await reviewWorkshopManifest({userId,manifestYaml:yaml,allowExistingWorkshopId:id});
    if(!review.ok)throw Error(JSON.stringify(review.issues));
    mkdirSync('.tmp/ai-content-upgrade',{recursive:true});
    writeFileSync('.tmp/ai-content-upgrade/before.yaml',baseline.manifestYaml,'utf8');
    writeFileSync('.tmp/ai-content-upgrade/candidate.yaml',yaml,'utf8');
    if(!process.argv.includes('--apply')) {console.log(JSON.stringify({status:'preview',version:baseline.commandVersion,issues:review.issues}));return;}
    await applyWorkshopManifestToExisting({userId,workshopId:id,manifestYaml:yaml,expectedVersion:baseline.commandVersion,commandId:`ai-content-20261001:${baseline.commandVersion}`,source:'owner',reason:'主人要求扩大 AI 知识博主关注范围，覆盖中小厂商、开源社区及其他 AI 新闻，保留内容审阅和暂停成片边界。'});
    const after=await exportWorkshopManifest(userId,id);if(!after)throw Error('Readback missing');
    const saved=YAML.parse(after.manifestYaml);if(saved.spec.mission!==YAML.parse(yaml).spec.mission||/[\uFFFD]|\?\?\?/.test(after.manifestYaml))throw Error('Readback mismatch');
    if(!saved.spec.modelConfig.allowedTools.includes('webSearch'))throw Error('Discovery tool missing');
    for(const l of saved.spec.loops) {
      const previous=YAML.parse(baseline.manifestYaml).spec.loops.find((item:any)=>item.name===l.name);
      if(previous&&previous.status!==l.status)throw Error('Loop status changed');
      if(l.status!=='archived'&&(!l.verification.requiredFields.includes('discoveryCoverage')||!l.context.sources.some((source:any)=>source.name==='GitHub Trending')))throw Error('Discovery readback mismatch');
    }
    for(const l of saved.spec.loops) {if(l.actionPolicy.allowed.some(suspended)||!l.verification.requiredFields.includes('readerReview'))throw Error('Policy readback mismatch');}
    writeFileSync('.tmp/ai-content-upgrade/after.yaml',after.manifestYaml,'utf8');
    console.log(JSON.stringify({status:'applied',version:after.commandVersion,loops:saved.spec.loops.map((l:any)=>({name:l.title,requiredFields:l.verification.requiredFields})),issues:review.issues},null,2));
  } finally {await closeDb();}
}
main().catch(e=>{console.error(e.message,e.cause?.code);process.exitCode=1;});
