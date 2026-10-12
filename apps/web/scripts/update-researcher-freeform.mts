import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';

const base = 'http://127.0.0.1:3515';
const workId = 'cec5143f-567b-453d-9d18-4ad90d193572';
const loopId = '2cf7ef58-3349-4e6c-b54f-80d91b107d70';
const owner = 'dcb1985e-3fe2-42fd-8978-7b04d1772850';
const folder = resolve('.tmp/researcher-freeform-value-20261002');
mkdirSync(folder, { recursive: true });
const requiredFields = ['reportMarkdown', 'researchProcess', 'projectAssessment', 'checkpoint', 'warnings'];
async function api(path: string, body?: unknown, method = 'POST') {
  const response = await fetch(base + path, body === undefined ? undefined : {
    method, headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(JSON.stringify({ status: response.status, result }));
  return result;
}
function save(name: string, value: unknown) {
  writeFileSync(resolve(folder, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2), 'utf8');
}
function checkUtf8(value: unknown) {
  if (/\uFFFD|\?{3}/u.test(JSON.stringify(value))) throw new Error('UTF-8 corruption marker');
}
function revise(manifest: any, stamp: string) {
  const spec = manifest.spec;
  spec.modelConfig.researchRoleVersion = '2.3.0';
  spec.modelConfig.researchReportStyle = 'freeform_project_value';
  spec.modelConfig.workVersion = stamp;
  spec.mission = `作为知遇项目的长期技术研究员，理解主人目标、项目架构、当前实现和真实问题，持续从外部一手知识中寻找能帮助项目推进的知识与机会。
维护带源码版本与证据的项目认知、研究问题、机会状态和主人反馈；发现源码变化或旧结论错误时重新核验。
每天检查外部变化，优先围绕知遇桌面 Web 与必要后端的真实问题选题，不强制追逐新论文。
有价值时自由展开汇报，不限固定字数、章节或结论数量。深入解释文章机制，对照知遇当前代码与已有能力，论证真正的增量、适用条件、反例及怎样验证价值；无价值或暂不适用也应如实判断，不凑机会。
正文组织由研究内容决定，内部证据、状态和检查点独立保存，不要求把工具日志或 JSON 字段写成汇报章节。没有有用增量时保留内部检查点，沿用有价值再汇报。
按 agent-frontier-research Skill 区分作者主张、源码观察、已有实测和推断，不编造引用、复现、性能收益或成本；验证建议不能冒充已执行实验。
仅研究、记录本 Work 知识并提出建议；不得自动修改代码、配置、权限或外发。建议是否采纳以及实验是否执行由主人决定。`;
  const loop = spec.loops.find((item: any) => item.name === 'agent-frontier-study');
  if (!loop) throw new Error('Target loop missing');
  loop.description = '持续理解项目并阅读一手资料，有价值时自由深入汇报文章机制对当前知遇的适用性与可验证增量。';
  loop.goal = '用真实源码与一手资料论证读到的知识怎样帮助知遇，形成主人可判断、可追溯的研究；不为格式压缩论证，不强行产出机会，不足如实披露，保存纠错与下一轮状态。';
  loop.context.instructions = '按 agent-frontier-research 2.3.0 从知遇真实问题出发，Grep 定位符号并 Read 相关 repo/ 源码及调用链，定向搜索并实际阅读一手资料。沿着文章机制与项目现状的具体关系深入分析，判断已有等价能力、真正增量、成立前提、失败或不适用情况及可证伪的验证办法；这些是思考要求，不是固定章节。正文自由组织、不限固定字数或结论数量，不写工具流水账，不重复完整正文。内部仅 reportMarkdown、researchProcess、projectAssessment、checkpoint、warnings 为必填，其余研究字段按需使用。登记副本只作导航；sourceEvidence 必须填真实工具回执的 path/sha256/startLine/endLine，独立验收继续核对实际过程。研究不足、网页未验证或工具降级明示 status、gaps 和下一步；不以未审查判定已违规，不将作者实验数字套作本项目收益或成本。通知依据在 projectAssessment.notificationReason 中说明，继续每天有价值再汇报。保持只读与现有 denied 边界；不能执行 shell、修改代码配置或外发，未执行测试必须说明。报告与记忆的事实、范围、限制和下一轮窗口一致，用户可在本车间查看、纠正或暂停。';
  loop.verification.requiredFields = [...requiredFields];
  loop.verification.successCriteria = [
    'sufficient 必须有成功 Grep、两份不同 repo 源码真实哈希与已读行范围、定向 webSearch 和一手正文回执；独立验收不信自报，证据门槛保持原样。',
    '自由正文围绕文章与知遇实际实现论证有效增量、适用条件和可证伪验证；可以指出无增量或暂不适用，不以字数、章节数量或字段标题判断价值。',
    '证据不足或工具降级明确缺口和下一步，不冒充全行业无变化；有实证纠错、阻塞或决策需求可明确理由汇报。',
    '区分作者主张、源码观察、已有实测和推断；不编造实施成本或性能收益，状态保存以真实回执为准。',
  ];
  if (spec.presentation) delete spec.presentation.requiredSections;
  if (spec.modelConfig.manifestSpec?.presentation) delete spec.modelConfig.manifestSpec.presentation.requiredSections;
  return manifest;
}

const phase = process.argv[2] ?? 'prepare';
if (phase === 'prepare') {
  const before = await api(`/api/workshops/${workId}/manifest`);
  save('before.json', before);
  save('template-before.yaml', readFileSync(resolve('../../manifests/workshops/agent-frontier-researcher.workshop.yaml'), 'utf8'));
  save('directives-before.json', await api(`/api/workshops/${workId}/directives`));
  save('detail-before.json', await api(`/api/workshops/${workId}/loops/${loopId}/detail`));
  const candidate = YAML.stringify(revise(YAML.parse(before.manifestYaml), new Date().toISOString()));
  checkUtf8(candidate); save('candidate.yaml', candidate);
  const dry = await api(`/api/workshops/${workId}`, { manifestYaml: candidate, dryRun: true }, 'PATCH');
  save('dry-run.json', dry);
  if (!dry.review?.ok) throw new Error(JSON.stringify(dry.review));
  console.log(JSON.stringify({ prepared: true, baselineVersion: before.commandVersion, review: dry.review }));
} else if (phase === 'apply') {
  const before = JSON.parse(readFileSync(resolve(folder, 'before.json'), 'utf8'));
  const candidate = readFileSync(resolve(folder, 'candidate.yaml'), 'utf8');
  save('apply-receipt.json', await api(`/api/workshops/${workId}`, {
    manifestYaml: candidate, expectedVersion: before.commandVersion, commandId: `researcher-freeform-v230:${before.commandVersion}`,
  }, 'PATCH'));
  const after = await api(`/api/workshops/${workId}/manifest`);
  checkUtf8(after); save('manifest-readback.json', after);
  const actual = YAML.parse(after.manifestYaml);
  if (actual.spec.modelConfig.researchReportStyle !== 'freeform_project_value' || actual.spec.modelConfig.researchRoleVersion !== '2.3.0') throw new Error('Style/version readback mismatch');
  const actualLoop = actual.spec.loops.find((item: any) => item.name === 'agent-frontier-study');
  if (JSON.stringify(actualLoop.verification.requiredFields) !== JSON.stringify(requiredFields)) throw new Error('Internal contract readback mismatch');
  const templatePath = resolve('../../manifests/workshops/agent-frontier-researcher.workshop.yaml');
  const template = revise(YAML.parse(readFileSync(templatePath, 'utf8')), actual.spec.modelConfig.workVersion);
  writeFileSync(templatePath, YAML.stringify(template), 'utf8'); checkUtf8(readFileSync(templatePath, 'utf8'));
  const content = '主人反馈（2026-10-02）：工作汇报过浅，正文可以自由发挥，重点是验证所读文章对知遇项目的价值。取消旧指令中的固定字数、章节、最多一个结论或机会等呈现限制；围绕文章机制、当前源码及等价能力、增量与成立条件、反例、可证伪验证深入论证，不为格式收缩内容、不强行采纳或凑建议。这些是判断要求，不是新的必填目录。内部结构与真实证据继续保留，旧事实纠错、unknown/降级披露、只读权限和每天有价值再汇报继续有效。';
  save('owner-feedback-receipt.json', await api(`/api/workshops/${workId}/commands`, {
    command: 'addWorkDirective', commandId: 'researcher-freeform-v230-owner-feedback-20261002', scope: 'persistent', triggerRun: false,
    reason: '按主人明确偏好放开汇报形式并加强文章对项目价值的论证。', content,
  }));
  const directives = await api(`/api/workshops/${workId}/directives`); checkUtf8(directives); save('directives-readback.json', directives);
  if (!JSON.stringify(directives).includes('正文可以自由发挥')) throw new Error('Owner feedback readback missing');
  console.log(JSON.stringify({ saved: true, roleVersion: '2.3.0', configurationVersion: after.commandVersion, requiredFields, feedbackReadback: true }));
} else if (phase === 'probe') {
  const { config } = await import('dotenv'); config({ path: '.env.local', quiet: true }); config({ path: '.env', quiet: true });
  const { getWorkshop } = await import('../lib/workshops/service');
  const { getLoop } = await import('../lib/loops/service');
  const { loadWorkshopRunSkills } = await import('../lib/workshops/run-prompt-skills');
  const { workshopBoundaryToLoopPolicies } = await import('../lib/workshops/boundary-policy');
  const work = await getWorkshop(owner, workId), loop = await getLoop(owner, loopId);
  if (!work || loop?.workshopId !== workId) throw new Error('Owner scope unavailable');
  const skills = loadWorkshopRunSkills(work, loop.name).map(s => ({ name: s.name, version: s.version, status: s.status, source: s.source }));
  const bridge = workshopBoundaryToLoopPolicies({ workshop: work, actionPolicy: loop.actionPolicy, approvalPolicy: loop.approvalPolicy });
  if (!skills.some(s => s.name === 'agent-frontier-research' && s.version === '2.3.0' && s.status === 'loaded')) throw new Error('Skill loader mismatch');
  const model = work.modelConfig as any;
  if (model.researchReportStyle !== 'freeform_project_value') throw new Error('Runtime style mismatch');
  const result = { modelRun: false, roleVersion: model.researchRoleVersion, reportStyle: model.researchReportStyle, loopStatus: loop.status, trigger: loop.triggerConfig, skills, requiredFields: loop.verificationConfig.requiredFields, allowed: bridge.actionPolicy.allowed, denied: bridge.actionPolicy.denied, boundary: bridge.metadata };
  save('loader-and-boundary-probe.json', result); console.log(JSON.stringify(result)); process.exit(0);
} else if (phase === 'start') {
  save('trial-directive.json', await api(`/api/workshops/${workId}/commands`, {
    command: 'addWorkDirective', commandId: 'researcher-freeform-v230-matched-trial-20261002', scope: 'current_run', triggerRun: false,
    reason: '同一问题的一次有限行为验证：检查放开格式是否让文章与项目的关系论证更有价值。',
    content: '继续核验上轮涉及的智能体安全审计/执行约束论文，对照知遇当前报告质量评审与其真正调用链，判断这类方法是否解决了项目的真实问题以及有什么有效增量。旧论文和旧报告只是线索，须重新确认作者机制、前提与实验范围，以及项目已有能力和相关上下游。正文可以自由深入展开，不要求固定章节、字数或结论数量，不写工具流水账；不要为了提出建议强行迁移，暂不适用也可以给出有依据的分析。将作者实验与知遇效果、源码观察与实际测试分清，不把未审查判成已违规，不把论文数字套作本项目成本收益。检索要有明确域名或时间窗，网页读取范围与未核验重定向如实披露。保持现有只读边界，不执行 shell、测试、代码配置变更或外发；研究不充分按实际缺口记录，不能自报充分。内部状态与记忆保存真实限制和下一步，全文 reportMarkdown 只保存一次。',
  }));
  const receipt = await api(`/api/workshops/${workId}/loops/${loopId}/execute`, {
    commandId: 'researcher-freeform-v230-native-trial-20261002', mode: 'native_agent', wait: false, createOutboxDrafts: false,
  });
  save('trial-enqueue.json', receipt); console.log(JSON.stringify(receipt));
} else if (phase === 'correct') {
  const memoryId = '40cc04b5-2605-4d8e-b483-f88688c3eed1';
  const reason = '第十轮 a2d83da2 的独立验收为 blocked，原报告与回执保留。已读 report-quality-evaluator.ts 中自由研究员分支跳过标题、600字符、3章节、工具推理关键词规则，不能把默认分支当本车间有效要求。loop-runtime.ts:309 位于 complete 回调，不能称租约关闭后；该局部返回值未参与此前草稿创建不证明所有通知、调度或完成链都不受门控。execution-lease 的真实连续已读范围是 1-80 与 80-135，全文引用 1-136 超出回执；finalUrlVerified=false 的两次 arXiv abs 抓取不是独立验证正文，Resume Means Resume 本轮未 webReadPage。没有定向域名/时间窗搜索，不能自报 sufficient。ACRFence 核心还包括不可逆效应账本、等价意图回放已有回执或显式 fork、保护已消费授权，作者未实施和评估其防御，不能仅以搜索摘要称为成熟语义去重方案。审批不证明效果恰好一次；尚未核全 outbox/recorded-step 的幂等范围，不能断言知遇完全没有意图幂等或 checkpoint-replay。applyRecordedStep 还有 output-step、run-plan 和 mcp-tools 使用，不限 loop:${kind}。SF3 是恢复后外部依赖/策略/对象变化，不可将 effect_started 直接等同其完整防护；planning/tool-execution 已有权限门控，不能仅凭未读断言无防护。连续两次新运行不等于同一意图故障恢复，重复副作用验证须隔离同一接受命令/运行/分支，模拟外部已提交而回执丢失，观测效应及授权次数，不能真实发送。';
  save('trial-memory-review.json', await api(`/api/brain/candidates/${memoryId}/review`, { decision: 'weakened', reason }));
  save('trial-correction-directive.json', await api(`/api/workshops/${workId}/commands`, {
    command: 'addWorkDirective', commandId: 'researcher-freeform-v230-trial-correction-20261002', scope: 'persistent', triggerRun: false,
    reason: '实际过程验收与论文/源码复审发现范围和机制错配，保留历史并纠正状态。', content: reason,
  }));
  const memories = await api(`/api/workshops/${workId}/memories`); save('memories-after-review.json', memories); checkUtf8(memories);
  const items = Array.isArray(memories) ? memories : memories.memories ?? [];
  if (items.find((item: any) => item.id === memoryId)?.status !== 'weakened') throw new Error('Memory review readback mismatch');
  const directives = await api(`/api/workshops/${workId}/directives`); save('directives-after-review.json', directives); checkUtf8(directives);
  if (!JSON.stringify(directives).includes('审批不证明效果恰好一次')) throw new Error('Correction readback mismatch');
  console.log(JSON.stringify({ corrected: true, memoryId, status: 'weakened', originalPreserved: true }));
} else if (phase === 'inspect') {
  const detail = await api(`/api/workshops/${workId}/loops/${loopId}/detail`); save('trial-detail.json', detail);
  const run = detail.loop?.latestRun; if (!run) throw new Error('No latest run');
  const events = await api(`/api/workshops/${workId}/events?runId=${run.id}&limit=2000`); save('trial-events.json', events);
  const items = Array.isArray(events) ? events : events.events ?? [];
  const counts: Record<string, number> = {};
  for (const item of items.filter((item: any) => item.type === 'tool_call')) { const name = item.metadata?.toolName ?? item.title; counts[name] = (counts[name] ?? 0) + 1; }
  console.log(JSON.stringify({ runId: run.id, status: run.status, verificationPassed: run.verificationPassed, startedAt: run.startedAt, completedAt: run.completedAt, error: run.error, toolCounts: counts, tail: items.slice(-2).map((item: any) => ({ type: item.type, title: item.title, body: item.body?.slice(0, 400) })) }, null, 2));
} else if (phase === 'evidence') {
  const { config } = await import('dotenv'); config({ path: '.env.local', quiet: true }); config({ path: '.env', quiet: true });
  const target = process.argv[3] ?? JSON.parse(readFileSync(resolve(folder, 'trial-detail.json'), 'utf8')).loop.latestRun.id;
  const { getLoop, listLoopRuns } = await import('../lib/loops/service');
  const loop = await getLoop(owner, loopId); if (loop?.workshopId !== workId) throw new Error('Owner scope mismatch');
  const runs = await listLoopRuns(loopId, { limit: 20 }); const run = runs.find((item: any) => item.id === target); if (!run) throw new Error('Run missing');
  save(`run-${target}.json`, run);
  const { db } = await import('../lib/db'); const { sql } = await import('drizzle-orm');
  const rows = await db.execute(sql`SELECT x.result_json FROM workshop_loop_executions x JOIN workshops w ON w.id=x.workshop_id WHERE x.run_id=${target}::uuid AND x.loop_id=${loopId}::uuid AND w.id=${workId}::uuid AND w.user_id=${owner}::uuid`);
  if (!rows[0]?.result_json) throw new Error('Captured result missing');
  save(`captured-${target}.json`, rows[0].result_json);
  const verification = run.verificationResult as any;
  console.log(JSON.stringify({ runId: run.id, status: run.status, passed: verification?.passed, issues: verification?.checker?.issues })); process.exit(0);
} else throw new Error('Unknown phase');
