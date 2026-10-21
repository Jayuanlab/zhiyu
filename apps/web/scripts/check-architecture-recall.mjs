import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'dotenv';
for (const name of [path.resolve('../../.env'), '.env', '.env.local']) {
  if (fs.existsSync(name)) for (const [key, value] of Object.entries(parse(fs.readFileSync(name)))) {
    if (!(key in process.env)) process.env[key] = value;
  }
}
const { actorId: userId } = await fetch('http://127.0.0.1:3515/api/identity').then(r => r.json());
if (!userId) throw Error('Missing owner');
const { buildBrainRecallPlan } = await import("../lib/memory/retrieval/recall-planner.ts");
const { listBrainMemoriesForUser } = await import("../lib/memory/retrieval/candidates.ts");
const start = Date.now();
if (process.argv.includes('--tool-only')) {
  const { createNativePiWebChatTools } = await import('../lib/ai/native-pi-web-chat-tools.ts');
  const tools = createNativePiWebChatTools({ userId, policy: { allowedTools: ['brainListMemories'], defaultDecision: 'deny' } });
  const result = await tools.find(t => t.name === 'brainListMemories').execute('architecture-memory-readback', { limit: 100, statuses: ['verified'], memoryTypes: ['fact'], ownerType: 'chat', ownerId: userId });
  const text = result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  const parsed = JSON.parse(text);
  const memories = parsed.memories ?? parsed.data?.memories ?? [];
  const architecture = memories.filter(m => m.metadata?.catalog === 'architecture-v1');
  const report = { at: new Date().toISOString(), track: 'actual Pi guarded read tool, without model', count: architecture.length,
    ownerIsolation: memories.every(m => m.userId === userId), trace: result.details?.trace, ms: Date.now()-start };
  fs.writeFileSync(path.resolve('../../.runtime/architecture-memory/pi-tool-check.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify(report));
  process.exit(report.count === 12 && report.ownerIsolation ? 0 : 1);
}
const plan = await buildBrainRecallPlan({ requester: { type: 'chat', userId }, taskIntent: 'Chat、Work、Loop 在系统架构中分别承担什么职责？', action: { kind: 'answer' } });
const memories = await listBrainMemoriesForUser({ userId, statuses: ['verified'], searchTerms: ['系统架构'], limit: 100 });
const architecture = memories.filter(m => m.metadata?.catalog === 'architecture-v1');
const report = { at: new Date().toISOString(), mode: plan.mode, warnings: plan.warnings, searchTerms: plan.searchTerms,
  memoryTypes: plan.memoryTypes, canonicalKinds: plan.canonicalKinds, architectureMemoryCount: architecture.length,
  architectureIds: architecture.map(m => m.id), ms: Date.now()-start };
fs.writeFileSync(path.resolve('../../.runtime/architecture-memory/recall-check.json'), JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify(report));
process.exit(plan.mode === 'llm' && architecture.length === 12 ? 0 : 1);
