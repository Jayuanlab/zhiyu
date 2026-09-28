import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { parse } from 'dotenv';
const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(web, '../..');
const { folder, runFolder } = JSON.parse(fs.readFileSync(path.join(root, '.runtime/evals/platform-memory-real-100/latest-run.json'), 'utf8'));
const read = name => JSON.parse(fs.readFileSync(path.join(folder, name), 'utf8'));
const cases = read('cases.json'), manifest = read('manifest.json'), snapshot = read('snapshot.json');
const docs = fs.readFileSync(path.join(folder, 'corpus.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const norm = v => JSON.parse(JSON.stringify(v));
const equal = (a, b) => { try { assert.deepStrictEqual(norm(a), norm(b)); return true; } catch { return false; } };
const sha = value => createHash('sha256').update(value).digest('hex');
for (const name of ['cases.json','snapshot.json','corpus.jsonl','questions.jsonl']) {
  if (sha(fs.readFileSync(path.join(folder, name))) !== read('integrity.json')[name]) throw Error(`Dataset altered: ${name}`);
}
const driftFile = path.join(runFolder, 'source-drift.json');
if (process.argv.includes('--check-live')) {
  const env = {};
  for (const name of [path.join(root,'.env'),path.join(web,'.env'),path.join(web,'.env.local')]) if (fs.existsSync(name)) Object.assign(env,parse(fs.readFileSync(name)));
  Object.assign(env,process.env);
  const url = new URL(env.POSTGRES_URL || env.DATABASE_URL);
  if (!['localhost','127.0.0.1','[::1]'].includes(url.hostname)) throw Error('Local DB required');
  const sql = postgres(url.toString(),{max:1,onnotice:()=>{}});
  const live = {}, aggregates = {};
  try {
    await sql.begin('isolation level repeatable read read only', async tx => {
      await tx`SET LOCAL statement_timeout = '30000'`;
      for (const [table, source] of Object.entries(snapshot.sources)) live[table] = norm(await tx.unsafe(source.query,source.parameters));
      for (const doc of docs.filter(d => d.kind === 'database_aggregate')) aggregates[doc.id] = norm(await tx.unsafe(doc.query,doc.parameters));
      for (const join of snapshot.joins) for (let i=0;i<join.reads.length;i++) {
        const table = i === 0 ? join.left : join.right, r = join.reads[i];
        live[table].push(...norm(await tx.unsafe(r.query,r.parameters)));
      }
    });
  } finally { await sql.end(); }
  const results = {};
  for (const c of cases) {
    const changes = [];
    for (let i=0;i<c.evidence.length;i++) {
      const doc = docs.find(d => d.id === c.evidence[i]);
      if (doc.kind === 'repository_file') {
        if (sha(fs.readFileSync(path.join(root,doc.path))) !== doc.sha256) changes.push(`${doc.id}: file changed`);
      } else if (doc.kind === 'database_aggregate') {
        if (doc.content.groups ? !equal(doc.content.groups,aggregates[doc.id]) : doc.content.total !== aggregates[doc.id][0]?.total) changes.push(`${doc.id}: aggregation changed`);
      } else {
        const original = doc.content;
        const key = ['id','command_id','loop_id','workshop_id'].find(k=>k in original);
        const current = live[doc.table].find(r=>r[key]===original[key] && (!original.account_id || r.account_id===original.account_id));
        const relevant = c.expected.facts ?? (i === 0 ? c.expected.left : c.expected.right) ?? original;
        if (!current) changes.push(`${doc.id}: missing from current sample`);
        else for (const [field,value] of Object.entries(relevant)) {
          if (JSON.stringify(value)?.includes('[REDACTED]')) continue;
          if (!equal(value,current[field])) changes.push(`${doc.id}.${field}: changed`);
        }
      }
    }
    results[c.id] = { status: changes.length ? 'drift_detected' : 'unchanged', changes };
  }
  fs.writeFileSync(driftFile,JSON.stringify({checkedAt:new Date().toISOString(),scope:'expected fields and aggregates; captured during run, not historical replay',results},null,2));
  console.log(JSON.stringify({driftChecked:100,drifted:Object.values(results).filter(v=>v.status!=='unchanged').length}));
}
const drift = fs.existsSync(driftFile) ? JSON.parse(fs.readFileSync(driftFile,'utf8')) : null;
function retrieved(pack) {
  const refs = new Set();
  for (const item of pack.items ?? []) refs.add(`db:brain_memories:${item.id}`);
  for (const route of pack.routeResults ?? []) for (const item of route.results ?? []) {
    if (item.type === 'graph') refs.add(`db:memory_graph_relations:${item.id}`);
    if (item.type === 'interaction') refs.add(`db:interaction_memories:${item.id}`);
    if (item.type === 'memory') refs.add(`db:brain_memories:${item.id}`);
    if (item.type === 'knowledge') refs.add(`db:rag_chunks:${item.id}`);
    if (item.metadata?.evidenceStatus === 'resolved') {
      const table = {workshop_event:'workshop_events',interaction_event:'interaction_events',raw_message:'raw_messages'}[item.metadata.evidenceSource];
      if (table) refs.add(`db:${table}:${item.id}`);
    }
  }
  return [...refs];
}
// A referenced ID is not read evidence. Guard the central evaluation distinction.
assert.deepEqual(retrieved({items:[{id:'m',evidenceRefs:['e']}]}),['db:brain_memories:m']);
assert.deepEqual(retrieved({routeResults:[{results:[{id:'e',type:'evidence_ref',metadata:{evidenceStatus:'unresolved',evidenceSource:'interaction_event'}}]}]}),[]);
assert.deepEqual(retrieved({routeResults:[{results:[{id:'e',type:'evidence_ref',metadata:{evidenceStatus:'resolved',evidenceSource:'interaction_event'}}]}]}),['db:interaction_events:e']);
assert.deepEqual(retrieved({routeResults:[{results:[{id:'g',type:'graph',metadata:{evidence:[{eventId:'e'}]}}]}]}),['db:memory_graph_relations:g']);
const scored = cases.map(c => {
  const file = path.join(runFolder,`${c.id}.json`);
  const result = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file,'utf8')) : {id:c.id,status:'not_run'};
  const refs = retrieved(result.recall ?? {});
  const hits = c.evidence.filter(ref=>refs.includes(ref));
  const isBoundary = c.category === '真实对象边界';
  return { id:c.id, category:c.category, domain:c.domain, status:result.status,
    goldSourceHits:hits, expectedSources:c.evidence, retrievedSources:refs,
    fullSourceHit:hits.length===c.evidence.length, anySourceHit:hits.length>0,
    sourceMatchStatus:isBoundary?'boundary_manual_review_required':hits.length===c.evidence.length?'full':hits.length?'partial':'none',
    note:'Exact source ID coverage only; not semantic answer accuracy. Referenced-but-unread IDs do not count.',
    drift:drift?.results[c.id] ?? {status:'not_checked'},
    plannerMode:result.recall?.recallPlan?.mode, plannerWarnings:result.recall?.recallPlan?.warnings ?? [],
    attempts:result.recall?.queryRetryTrace?.attempts, stopReason:result.recall?.queryRetryTrace?.stopReason,
    selectedCount:result.recall?.items?.length??0,
    sourceProblems:(result.recall?.routeResults??[]).filter(r=>['failed','degraded'].includes(r.status)).map(r=>({route:r.route,status:r.status,error:r.error})),
    totalMs:result.totalMs, startedAt:result.startedAt, finishedAt:result.finishedAt,
    finishReason:result.finishReason, answerUsage:result.answerUsage, answer:result.answer, error:result.error };
});
const factual = scored.filter(c=>c.category!=='真实对象边界');
const stable = factual.filter(c=>c.drift.status==='unchanged');
const accessFile=path.join(runFolder,'returned-owner-check.json');
if(process.argv.includes('--check-access')){
  const env={};for(const name of [path.join(root,'.env'),path.join(web,'.env'),path.join(web,'.env.local')])if(fs.existsSync(name))Object.assign(env,parse(fs.readFileSync(name)));
  Object.assign(env,process.env);
  const url=new URL(env.POSTGRES_URL||env.DATABASE_URL);
  if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw Error('Local DB required');
  const sql=postgres(url.toString(),{max:1,onnotice:()=>{}});
  const ids=[...new Set(scored.flatMap(c=>c.retrievedSources).filter(id=>id.startsWith('db:brain_memories:')).map(id=>id.split(':').at(-1)))];
  try{
    const rows=ids.length?await sql`SELECT id,user_id FROM brain_memories WHERE id IN ${sql(ids)}`:[];
    fs.writeFileSync(accessFile,JSON.stringify({checkedAt:new Date().toISOString(),selectedUniqueMemories:ids.length,found:rows.length,foreignUserRows:rows.filter(r=>r.user_id!==manifest.ownerId).length,missingRows:ids.length-rows.length,
      scope:'Actual returned Brain rows only; Chat owner scope, not a cross-Work authorization test'},null,2));
  }finally{await sql.end();}
}
const countBy = key => Object.fromEntries([...new Set(scored.map(c=>c[key]??'unknown'))].map(k=>[k,scored.filter(c=>(c[key]??'unknown')===k).length]));
const latency = scored.map(c=>c.totalMs).filter(Number.isFinite).sort((a,b)=>a-b);
const summary = {generatedAt:new Date().toISOString(),snapshotAt:manifest.capturedAt,total:100,
  executionStatus:countBy('status'),plannerModes:countBy('plannerMode'),
  factualCases:95,exactSourceFullHits:factual.filter(c=>c.fullSourceHit).length,exactSourceAnyHits:factual.filter(c=>c.anySourceHit).length,
  stableFactualCases:stable.length,stableExactSourceFullHits:stable.filter(c=>c.fullSourceHit).length,stableExactSourceAnyHits:stable.filter(c=>c.anySourceHit).length,
  returnedNonempty:scored.filter(c=>c.selectedCount>0).length,secondAttempts:scored.filter(c=>c.attempts===2).length,
  withSourceProblems:scored.filter(c=>c.sourceProblems.length>0).length,
  stopReasons:countBy('stopReason'),
  driftDetected:scored.filter(c=>c.drift.status==='drift_detected').length,
  medianMs:latency[Math.floor(latency.length/2)],p95Ms:latency[Math.ceil(latency.length*0.95)-1],
  truncatedAnswers:scored.filter(c=>['max_tokens','length'].includes(c.finishReason)).length,
  answerAccuracy:'not automatically scored; exact source coverage is not answer correctness',
  boundaryResults:'manual review pending; no action tools were provided',
  limits:['Production Brain service called directly; HTTP authentication/UI not under test.','Answer generation uses a separate tool-free harness with the existing configured model.','Only original questions run; no natural variants or A/B baseline.','No gold answers or offline corpus were imported into retrieval.']};
const grades=fs.readdirSync(runFolder).filter(name=>/^judge-\d+\.json$/.test(name)).flatMap(name=>{
  const value=JSON.parse(fs.readFileSync(path.join(runFolder,name),'utf8'));return value.status==='completed'?value.grades:[];
});
const humanFile=path.join(runFolder,'human-review.json');
const human=fs.existsSync(humanFile)?JSON.parse(fs.readFileSync(humanFile,'utf8')):null;
for(const override of human?.overrides??[]){const i=grades.findIndex(g=>g.id===override.id);if(i>=0)grades[i]={...grades[i],...override};else grades.push({...override,gradingSource:'manual'});}
if(grades.length){
  const stableIds=new Set(stable.map(c=>c.id));
  const gradedStable=grades.filter(g=>stableIds.has(g.id));
  summary.semanticReview={method:'Separate evaluator prompt on the same model, with documented manual corrections and manual completion of failed evaluator batches; provisional scoring',
    graded:grades.length,stableGraded:gradedStable.length,
    outcomes:Object.fromEntries([...new Set(grades.map(g=>g.outcome))].map(k=>[k,grades.filter(g=>g.outcome===k).length])),
    stableOutcomes:Object.fromEntries([...new Set(gradedStable.map(g=>g.outcome))].map(k=>[k,gradedStable.filter(g=>g.outcome===k).length])),
    stableMeanCorrectnessPointsOutOf40:gradedStable.length?Number((gradedStable.reduce((n,g)=>n+g.correctnessPoints,0)/gradedStable.length).toFixed(2)):null,
    manuallyReviewedIds:human?.reviewedIds??[]};
  summary.answerAccuracy='See provisional semanticReview; not a production end-to-end pass rate.';
}
if(human?.boundarySummary)summary.boundaryResults=human.boundarySummary;
if(fs.existsSync(accessFile))summary.returnedMemoryOwnerCheck=JSON.parse(fs.readFileSync(accessFile,'utf8'));
for(const row of scored)row.semanticGrade=grades.find(g=>g.id===row.id)??null;
fs.writeFileSync(path.join(runFolder,'scored.json'),JSON.stringify(scored,null,2));
fs.writeFileSync(path.join(runFolder,'summary.json'),JSON.stringify(summary,null,2));
const categories = [...new Set(scored.map(c=>c.category))].map(category=>{const rows=scored.filter(c=>c.category===category);return `| ${category} | ${rows.length} | ${rows.filter(c=>c.status==='completed').length} | ${rows.filter(c=>c.fullSourceHit).length} | ${rows.filter(c=>c.anySourceHit).length} |`;});
const md = `# 平台真实记忆 100 题实跑\n\n生成：${summary.generatedAt}\n\n测试实际 Brain 服务，再通过已有模型做无工具回答。没有导入答案或离线语料。正常召回审计会写入生产审计表，未调用业务写入工具。\n\n## 执行与证据\n\n\`\`\`json\n${JSON.stringify(summary,null,2)}\n\`\`\`\n\n| 类别 | 题数 | 回答完成 | 标准来源全命中 | 至少命中一个来源 |\n| --- | ---: | ---: | ---: | ---: |\n${categories.join('\n')}\n\n注意：来源全命中不等于字段全部可答；来源未命中也不自动等于回答内容全错。该指标严格对齐金标准来源 ID，架构/聚合来源缺失不能由常识猜答案替代。5 道边界题另行人工判读，不能凭禁用工具就证明生产工具权限通过。语义评分由相同配置模型在隔离评审提示词下生成，只有评审器能看到 gold；这不是独立模型验证，存在评审偏差，人工抽查见 human-review.json。\n\n## 逐题回答与轨迹\n\n` + scored.map(c=>`### ${c.id} · ${c.category}\n\n${cases.find(x=>x.id===c.id).question}\n\n执行：${c.status}；规划：${c.plannerMode??'无'}；轮次：${c.attempts??'无'}；候选：${c.selectedCount}；标准来源命中：${c.goldSourceHits.length}/${c.expectedSources.length}；耗时：${c.totalMs??'无'} ms；数据比对：${c.drift.status}。\n\n${c.semanticGrade?`辅助评分：${c.semanticGrade.outcome}，${c.semanticGrade.correctnessPoints}/40。${c.semanticGrade.reason}\n\n`:''}${c.error?`错误：${c.error}\n\n`:''}${c.answer??'没有生成回答。'}\n\n原始运行记录：[${c.id}.json](./${c.id}.json)\n`).join('\n');
fs.writeFileSync(path.join(runFolder,'report.md'),md,'utf8');
console.log(JSON.stringify(summary,null,2));
