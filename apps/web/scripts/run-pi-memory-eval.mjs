import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { buildMemoryEvalRequest } from './lib/pi-memory-eval-request.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const base = path.join(root, '.runtime/evals/platform-memory-real-100');
const folder = JSON.parse(fs.readFileSync(path.join(base, 'latest.json'), 'utf8')).folder;
const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'manifest.json'), 'utf8'));
const url = process.env.MEMORY_EVAL_URL ?? 'http://127.0.0.1:3515';
// Deliberately never read gold.jsonl or corpus.jsonl in the agent runner.
const questions = fs.readFileSync(path.join(folder, 'questions.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const ids = process.argv.find(a => a.startsWith('--ids='))?.slice(6).split(',');
const selected = ids ? questions.filter(q => ids.includes(q.id)) : questions;
const concurrency = Math.max(1, Math.min(4, Math.trunc(Number(process.argv.find(a => a.startsWith('--concurrency='))?.slice(14)) || 1)));
if (!selected.length || (ids && selected.length !== ids.length)) throw Error('Unknown or repeated case IDs');
const readTools = ['time', 'listWorkshopManifestCapabilities', 'inspectWorkshopAgent', 'listKnowledgeBaseDocuments',
  'getFullDocumentContent', 'searchKnowledgeBase', 'searchUnifiedMemory', 'searchMemoryPath', 'chatInsight',
  'queryContacts', 'brainListMemories', 'brainListCandidates', 'brainListSnapshots', 'brainListGrants', 'platformRecall', 'listLoopTasks'];
const allowedTools = process.argv.find(a => a.startsWith('--tools='))?.slice(8).split(',') ?? readTools;
if (allowedTools.some(name => !readTools.includes(name))) throw Error('Only supported read-only tools are allowed');
for (const question of selected) {
  const requiredTools = question.evalRequirements?.requiredTools ?? [];
  const missing = requiredTools.filter(name => !allowedTools.includes(name));
  if (missing.length) {
    console.error(JSON.stringify({ error: 'missing_required_tools', id: question.id, missing }));
    process.exit(1);
  }
}
const identity = await fetch(`${url}/api/identity`).then(r => r.json());
if (identity.actorId !== manifest.ownerId) throw Error('Evaluation owner mismatch');
const out = path.join(folder, `pi-run-${new Date().toISOString().replace(/[:.]/g, '-')}`);
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'run.json'), JSON.stringify({ at: new Date().toISOString(), track: 'actual desktop Pi HTTP agent and read-only runtime tools',
  inputProtocol: 'raw-user-question.v2', routingHintsInjected: false,
  inputBuilderHash: createHash('sha256').update(fs.readFileSync(new URL('./lib/pi-memory-eval-request.mjs', import.meta.url))).digest('hex'),
  provider: 'pi', allowedTools, concurrency, goldInjected: false, knowledgeState: 'source-backed architecture catalog and live owner-scoped platform retrieval; not an unchanged baseline', cases: selected.map(q => q.id),
  sourceHashes: Object.fromEntries(['apps/web/app/api/native/agent/route.ts', 'apps/web/lib/ai/native-pi-user-config.ts', 'apps/web/lib/brain/recall-planner.ts', 'apps/web/lib/brain/jev-recall-router.ts', 'apps/web/lib/ai/jev-platform-prefetch.ts', 'apps/web/lib/ai/platform-recall.ts', 'apps/web/lib/ai/platform-record-reader.ts', 'apps/web/lib/ai/platform-paper-records.ts', 'apps/web/lib/ai/platform-answer-coverage.ts', 'apps/web/lib/ai/platform-statistics.ts', 'apps/web/lib/ai/native-pi-web-chat-tools.ts'].map(file =>
    [file, createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')])) }, null, 2));
fs.writeFileSync(path.join(base, 'latest-pi-run.json'), JSON.stringify({ folder, runFolder: out }, null, 2));
let failed = 0;
let requirementFailed = 0;
let nextQuestion = 0;
await Promise.all(Array.from({ length: concurrency }, async () => {
while (nextQuestion < selected.length) {
  const question = selected[nextQuestion++];
  const start = Date.now();
  const record = { id: question.id, question: question.question, provider: 'pi', events: [], status: 'running' };
  const save = () => fs.writeFileSync(path.join(out, `${question.id}.json`), JSON.stringify(record, null, 2), 'utf8');
  try {
    const response = await fetch(`${url}/api/native/agent`, { method: 'POST', signal: AbortSignal.timeout(180000),
      headers: { 'Content-Type': 'application/json', Origin: url }, body: JSON.stringify(buildMemoryEvalRequest(question, allowedTools)) });
    if (!response.ok) throw Error(`Agent HTTP ${response.status}: ${(await response.text()).slice(0,1000)}`);
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true }).replace(/\r/g, '');
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0,end); buffer = buffer.slice(end+2);
        for (const line of frame.split('\n').filter(l => l.startsWith('data: '))) {
          const data = line.slice(6); if (data !== '[DONE]') record.events.push(JSON.parse(data));
        }
        save();
      }
    }
    const errors = record.events.filter(e => e.type === 'error' || e.isError);
    record.status = errors.length ? 'agent_error' : record.events.some(e => e.type === 'result') && record.events.some(e => e.type === 'done') ? 'completed' : 'incomplete';
  } catch (error) { record.status = 'failed'; record.error = String(error.message).replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED]'); }
  record.toolCalls = record.events.filter(e => e.type === 'tool_use');
  record.evalRequirements = question.evalRequirements ?? null;
  const toolNames = record.toolCalls.map(call => call.name).filter(Boolean);
  const toolResults = record.events.filter(e => e.type === 'tool_result');
  const resultIds = new Set(toolResults.map(result => result.toolUseId).filter(Boolean));
  const completedToolNames = [...new Set(record.toolCalls
    .filter(call => resultIds.has(call.id ?? call.toolUseId))
    .map(call => call.name)
    .filter(Boolean))];
  const requiredTools = record.evalRequirements?.requiredTools ?? [];
  record.requirementCheck = {
    requiredTools,
    toolNames,
    completedToolNames,
    missingRequiredTools: requiredTools.filter(name => !toolNames.includes(name)),
    missingRequiredToolResults: requiredTools.filter(name => !completedToolNames.includes(name)),
  };
  if (record.requirementCheck.missingRequiredTools.length > 0 || record.requirementCheck.missingRequiredToolResults.length > 0) {
    record.status = record.status === 'completed' ? 'requirement_failed' : record.status;
    requirementFailed++;
  }
  record.answer = record.events.filter(e => e.type === 'text').map(e => e.content ?? e.text ?? '').join('');
  record.results = record.events.filter(e => e.type === 'result');
  record.ms = Date.now() - start; save();
  if (record.status !== 'completed') failed++;
  console.log(JSON.stringify({ id: record.id, status: record.status, tools: record.toolCalls?.length ?? 0,
    missingRequiredTools: record.requirementCheck.missingRequiredTools,
    missingRequiredToolResults: record.requirementCheck.missingRequiredToolResults, ms: record.ms }));
}
}));
console.log(JSON.stringify({ output: out, completed: selected.length - failed, failed, requirementFailed }));
process.exitCode = failed ? 1 : 0;
