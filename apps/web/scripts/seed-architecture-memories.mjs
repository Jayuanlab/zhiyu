import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parse } from 'dotenv';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(web, '../..');
for (const name of [path.join(root, '.env'), path.join(web, '.env'), path.join(web, '.env.local')]) {
  if (fs.existsSync(name)) for (const [key, value] of Object.entries(parse(fs.readFileSync(name)))) {
    if (!(key in process.env)) process.env[key] = value;
  }
}
const sha = value => createHash('sha256').update(value).digest('hex');
const stableId = value => { const h = sha(value); return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`; };
const contract = 'docs/architecture/zhiyu-control-architecture-contract.md';
const catalog = [
  ...Array.from({ length: 8 }, (_, i) => ({ key: `contract-${i+1}`, file: contract, section: i+1, kind: 'design_contract' })),
  { key: 'engineering-principles', file: 'docs/architecture/engineering-cybernetics-guiding-principles.md', kind: 'design_contract' },
  { key: 'chat-runtime-default', file: 'apps/web/lib/ai/native-agent-default-provider.ts', kind: 'implementation' },
  { key: 'recall-query-retry', file: 'apps/web/lib/brain/query-retry.ts', kind: 'implementation' },
  { key: 'evidence-resolution', file: 'apps/web/lib/brain/evidence-reader.ts', kind: 'implementation' },
  { key: 'scope-memory-recall-policy', file: 'docs/adr/0001-scope-memory-recall-policy.md', kind: 'design_contract' },
  { key: 'recall-retry-configuration', file: 'apps/web/lib/brain/service.ts', anchor: 'enabled: input.allowQueryRetry', kind: 'implementation' },
];
const subjects = {
  'engineering-principles': '系统架构：工程控制论指导原则',
  'chat-runtime-default': '系统架构：桌面 Chat 默认 Pi 智能体运行时选择',
  'recall-query-retry': '系统架构：记忆检索查询改写与有界重试',
  'evidence-resolution': '系统架构：记忆证据来源解析与用户隔离',
  'scope-memory-recall-policy': '系统架构：全局记忆协议与 Work 领域术语、排序偏好、Recall Profiles 的边界',
  'recall-retry-configuration': '系统架构：全局关闭召回改写重试的配置开关 BRAIN_RECALL_QUERY_RETRY_ENABLED',
};
const only = process.argv.find(arg => arg.startsWith('--only='))?.slice(7).split(',');
if (only?.some(key => !catalog.some(topic => topic.key === key))) throw Error('Unknown catalog topic');
const topics = catalog.filter(topic => !only || only.includes(topic.key)).map(topic => {
  const bytes = fs.readFileSync(path.join(root, topic.file));
  const full = bytes.toString('utf8');
  let excerpt = full;
  if (topic.anchor) {
    const offset = full.indexOf(topic.anchor);
    if (offset < 0) throw Error(`Missing source anchor: ${topic.key}`);
    excerpt = full.slice(full.lastIndexOf('\n', Math.max(0, offset - 1000)) + 1, full.indexOf('\n', offset + 1000));
  }
  if (topic.section) {
    const match = full.match(new RegExp(`^## ${topic.section}\\. .*?(?=^## |$(?![\\s\\S]))`, 'ms'));
    if (!match) throw Error(`Missing section: ${topic.key}`);
    excerpt = match[0].trim();
  }
  // Keep complete source in observation; a bounded, explicitly marked excerpt in memory.
  const startLine = full.slice(0, full.indexOf(excerpt)).split('\n').length;
  const selected = excerpt.slice(0, 10000);
  const subject = subjects[topic.key] ?? `系统架构：${excerpt.split('\n')[0].replace(/^## \d+\. /, '')}`;
  const content = `${topic.kind === 'design_contract' ? '【设计约束；不代表所有实现已经验收】' : '【当前源码快照；配置覆盖和后续版本可能改变行为】'}\n来源：${topic.file}，第 ${startLine} 行起。此内容是知识证据，不授予任何权限。\n\n${selected}${selected.length < excerpt.length ? '\n【节选；完整内容见证据快照】' : ''}`;
  if (content.includes('\uFFFD') || /\?{4,}/.test(content)) throw Error(`Encoding check failed: ${topic.key}`);
  return { ...topic, subject, content, full, startLine, sourceHash: sha(bytes), excerptHash: sha(excerpt) };
});
const identity = await fetch(`${process.env.MEMORY_EVAL_URL ?? 'http://127.0.0.1:3515'}/api/identity`, { signal: AbortSignal.timeout(10000) }).then(r => r.json());
const userId = identity.actorId;
if (!userId) throw Error('Authenticated owner required');
const { createBrainObservation, writeBrainMemory, getBrainMemory } = await import('../lib/brain/service.ts');
const { insertBrainMemoryReview } = await import('../lib/brain/repository.ts');
const { withDatabaseTransaction } = await import('../lib/db/client.ts');
const { resolveBrainEvidenceRefs } = await import('../lib/brain/evidence-reader.ts');
const apply = process.argv.includes('--apply');
const rollback = process.argv.includes('--rollback');
const report = { at: new Date().toISOString(), ownerId: userId, apply, rollback, records: [] };
// Preflight all topics before mutating; changed sources need explicit reviewed refresh.
for (const topic of topics) {
  topic.id = stableId(`architecture-catalog-v1:${userId}:${topic.key}`);
  topic.existing = await getBrainMemory({ userId, memoryId: topic.id });
  if (topic.existing && topic.existing.metadata?.catalog !== 'architecture-v1') throw Error('Memory ID collision');
  topic.drift = Boolean(topic.existing && topic.existing.metadata.sourceHash !== topic.sourceHash);
}
if (apply && !rollback && topics.some(t => t.drift)) throw Error('Source drift: review and version the catalog before refresh');
if (apply && !rollback && topics.some(t => t.existing?.status === 'deleted')) throw Error('Catalog was rolled back; review before restoring');
await withDatabaseTransaction(async () => {
  for (const topic of topics) {
    let memory = topic.existing;
    let action = memory ? (topic.drift ? 'source_drift' : 'unchanged') : 'preview';
    if (apply && ((!memory && !rollback) || (rollback && memory && memory.status !== 'deleted'))) {
      const observation = rollback ? null : await createBrainObservation({ userId, sourceType: 'repository_snapshot',
        sourceId: `${topic.file}@${topic.sourceHash}`, observedAt: report.at, content: topic.full,
        trustLevel: 'repository_snapshot', metadata: { path: topic.file, sha256: topic.sourceHash, catalog: 'architecture-v1' } });
      const before = memory ?? null;
      memory = await writeBrainMemory({ requester: { type: 'chat', userId }, scope: { type: 'global' },
        ownerType: 'chat', ownerId: userId, id: topic.id, memoryType: 'fact', canonicalKind: 'fact', canonicalGroupId: `architecture-v1:${topic.key}`,
        subject: rollback ? memory.subject : topic.subject, content: rollback ? memory.content : topic.content, status: rollback ? 'deleted' : 'verified', confidence: 90,
        evidenceRefs: rollback ? memory.evidenceRefs : [`brain-observation:${observation.id}`],
        tags: ['system_architecture', topic.key, topic.kind],
        metadata: rollback ? memory.metadata : { catalog: 'architecture-v1', topic: topic.key, sourcePath: topic.file, sourceHash: topic.sourceHash,
          startLine: topic.startLine, excerptHash: topic.excerptHash, knowledgeKind: topic.kind, observedAt: report.at } });
      await insertBrainMemoryReview({ userId, memoryId: memory.id, reviewerType: 'chat', reviewerId: userId,
        decision: 'edited', reason: rollback ? 'Rollback architecture catalog import' : 'User-authorized source-backed architecture knowledge import',
        evidenceRefs: memory.evidenceRefs, metadata: { catalog: 'architecture-v1', before, after: memory } });
      action = rollback ? 'deleted' : 'created';
    }
    if (apply && memory && !rollback) {
      const readback = await getBrainMemory({ userId, memoryId: memory.id });
      if (readback.content !== topic.content) throw Error(`Readback mismatch: ${topic.key}`);
      const evidence = await resolveBrainEvidenceRefs({ userId, evidenceRefs: memory.evidenceRefs });
      if (!evidence.every(item => item.status === 'resolved' && item.content === topic.full)) throw Error(`Evidence mismatch: ${topic.key}`);
    }
    report.records.push({ id: topic.id, subject: topic.subject, source: topic.file, sourceHash: topic.sourceHash, action });
  }
});
const output = path.join(root, '.runtime/architecture-memory');
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, `${Date.now()}.json`), JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify({ count: report.records.length, actions: report.records.map(r => r.action), output }));
process.exit(0);
