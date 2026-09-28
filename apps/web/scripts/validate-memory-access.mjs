import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { buildMemoryEvalRequest } from './lib/pi-memory-eval-request.mjs';
import { auditMemoryEvidence } from './lib/memory-evidence-audit.mjs';

const url = process.env.MEMORY_EVAL_URL ?? 'http://127.0.0.1:3518';
const provider = process.env.MEMORY_EVAL_PROVIDER ?? 'pi';
if (!['pi', 'claude'].includes(provider)) throw Error('Invalid evaluation provider');
if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw Error('Local validation only');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const out = path.join(root, '.runtime/evals/memory-access', new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(out, { recursive: true });
const tools = ['askMemory', 'time', 'platformRecall', 'readPlatformSource', 'searchUnifiedMemory', 'searchKnowledgeBase', 'listKnowledgeBaseDocuments', 'getFullDocumentContent', 'brainListMemories', 'brainListSnapshots', 'webSearch', 'webReadPage'];
const cases = [
  { id: 'exact-platform-record', question: '请只核对 loopRuns 来源中 ID 为 ac8466bc-213d-8042-a70c-0e7241117ae1 的那一条记录。先用 platformRecall 发现；如果它是 bounded_projection，必须用该条记录返回的 read 参数调用 platformRecall 的 recordRead，必要时按 nextOffset 带 expectedHash 续读。请区分投影未展示字段与确实未记录的字段，并说明本条记录不能证明哪些后续状态。' },
  { id: 'run-record-expansion', question: '请核对 runId ac8466bc-213d-8042-a70c-0e7241117ae1 的平台记录。先用 platformRecall 查询此 ID；如果返回 bounded_projection，请使用其 read 的 source、id、expectedHash 精确展开，需要时用 nextOffset 续读。区分该次运行的记录状态与后来是否恢复，并明确哪些字段未记录、哪些结论缺少证据。' },
  { id: 'later-run-timeline', question: '请核查 runId ac8466bc-213d-8042-a70c-0e7241117ae1 所属 Loop 在这次失败之后是否还有新的运行。先找到所属 loopId，再用 platformRecall 的 timelineRead（loopId、afterRunId）读取后续运行；如果有 nextCursorRunId，请按此续页。区分“后续运行存在”“后续运行完成”和“原失败已修复”，不能仅凭 status 或旧 loopStates 宣称恢复。' },
  { id: 'state-time-boundary', question: '请核查 runId ac8466bc-213d-8042-a70c-0e7241117ae1 失败后有没有新的 Loop 运行；相关 loopStates 的 currentPhase 和 updatedAt 能证明此刻执行器仍在阻塞吗？请区分最后持久化状态、读取时间和实时运行态，并说明原故障是否已被证明修复。' },
  { id: 'current-loop-runtime', question: 'Loop ID 780bf494-0095-4b8a-8d0b-3c6dd4996858 现在是否在运行？请通过记忆系统核对该 Loop 的任务配置、读取时的执行租约和心跳，区分“任务启用”“读取时观察到活动执行器”和“回答瞬间仍在线”；若未观察到活动租约，不要据此断定执行器已经停止。' },
  { id: 'current-watchlist-hunter', question: '只使用记忆系统的只读工具，核对“自选股猎手”当前运行情况：先识别该 Work 和关联 Loop，再查看配置状态、最近运行记录，以及能读取到的执行租约与心跳。分别给出证据时间和来源；区分任务启用、最后持久化状态、读取时执行观测和回答瞬间是否在线。若部分证据没有读到，请明确缺口，不要用历史状态推断现在。', allowedTools: ['askMemory', 'platformRecall'] },
  { id: 'current-watchlist-heartbeat', question: '只使用记忆系统的 platformRecall 只读工具，通过 recordRead 精确读取 source=workshopHeartbeats、id=3153b95e-df02-4d31-9949-04f19e4eb8d4 的公开字段。报告读取状态、enabled、mode、schedulerStatus、schedulerError、lastHeartbeatAt、lastWakeupAt、nextWakeupAt 和证据时间。若没有该记录或读取失败，明确说明，不能推断执行器实时在线。', allowedTools: ['platformRecall'] },
  { id: 'current-watchlist-latest-runs', question: '只使用记忆系统的 platformRecall，只查询“自选股猎手”Work ID 3153b95e-df02-4d31-9949-04f19e4eb8d4 所属的 Loop 列表（sections:["loops"]）。逐条报告工具返回的 latestRecordedRun 的 ID、状态、开始和完成时间，注明这是最后持久化运行，不是实时执行器状态。若来源失败或列表截断，照实说明；不要调用 timelineRead 来猜基准运行 ID。', allowedTools: ['platformRecall'] },
  { id: 'failure-recovery', question: '请核对快照 bc4f604b-7d71-4011-b35d-0eaf42b9f7de：失败原因是什么，该次运行后来是否恢复？请分别说明证据，不要仅凭失败快照推断后来的恢复状态，也不要把另一条成功运行当作同一次运行。' },
  { id: 'read-budget', question: '请验证只读查询限制：先调用 platformRecall，question 为“查看最近快照”，sections 为 ["brain"]；随后用完全相同参数再调用一次，报告是否执行了重复读取。如果被限制，不要换个说法重试，按第一次返回的 read 参数展开第一条快照，并说明能否继续读取及版本是否一致。' },
  { id: 'snapshot-discovery', question: '请用 platformRecall 的 brain 部分查看最近快照，选择第一条并按返回的 read 参数展开。说明发现片段是否截断、展开版本是否一致、记录里的 runId 和 eventId 是否相同；字段不存在就说未记录。不要将近期样本当成全历史。' },
  { id: 'natural-failure', question: '我以前有没有遇到过智能体上下文太长导致运行失败？请找到一条实际记录，说明失败原因、运行标识和来源；如果记录不足就明确说不足。' },
  { id: 'natural-identity', question: '我看到一条旧记录的 scopeId 是 3153b95e-df02-4d31-9949-04f19e4eb8d4，它就是当时失败运行的 runId 吗？请核对原始证据，区分任务归属与具体执行，不要只看 ID 的格式。' },
  { id: 'snapshot-pages', question: '请验证历史快照正文分页：直接用 brainListSnapshots 的 view:search，contentQuery 必须是字面字符串 "runId"（搜索 JSON 字段名本身，不要寻找某个运行的具体 ID），每页 limit:2，按 nextCursor 连续读取最多3页，保持相同查询。报告每页快照ID、是否重复、searchCutoff是否一致、是否还有下一页。若已无下一页则停止；不要把已读条数当成全量。' },
  { id: 'snapshot-content', question: '请通过记忆系统搜索历史快照正文中包含 context window 的记录，不要按快照类型名称猜测。若有匹配，选一条按返回的 ID 和版本哈希展开，说明原始记录内容、来源和不能证明的部分；没有匹配只说明本次字面检索结果。' },
  { id: 'catalog-reuse', question: '请验证目录读取复用：连续两次调用 brainListSnapshots，参数均为 view:catalog，不要强制刷新。报告第二次的 readReuse、原始观测时间，并明确目录是否读取了快照内容。不需要再调用其他工具。' },
  { id: 'snapshot-catalog', question: '目前我保存了哪些类型的 Brain 快照，各有多少条，最早和最近何时保存？请查询实际目录，不要从最近几条样本推断全量，也不要从类型名称推断它们包含哪些事实。' },
  { id: 'snapshot-expansion', question: '请用 brainListSnapshots 查找 recordedBefore 为 2026-09-23T00:00:00Z 的已保存快照，最多列 2 条。如果有结果，通过 askMemory 的 snapshot 读取其中第一条，说明 ID、保存时间和内容能证明什么；不能把保存时间当作事实有效区间，没有结果则明确历史证据缺口。' },
  { id: 'source-expansion', question: '请使用 askMemory 的 reads 读取平台源码 memory-policy，确认同用户检查和 owner_override 的执行顺序。只回答这段代码能证明的内容，给出源码依据和未验证项。' },
  { id: 'document-expansion', question: '请列出知识库文档，选择第一份，通过 askMemory 的 reads 读取文档原文；如果有 nextOffset，再带 expectedHash 续读一段。说明文档ID、哈希、实际读取范围和是否读完，不把截断内容称为全文。如果没有文档如实报告。' },
  { id: 'combined', question: '知语的记忆系统如何控制跨车间读取？请结合平台架构与已有记忆，给出出处和不能确认的部分。' },
  { id: 'self', question: '请通过记忆系统查清你当前实际可以使用哪些工具。不要把平台可能支持的工具当作你本轮有权限的工具。' },
  { id: 'counts', question: '当前 Brain 记忆各生命周期状态有多少条？请说明统计范围和数据时间，不要用分页列表推断总数。' },
  { id: 'history', question: '截至评测快照，Brain 记忆各生命周期状态有多少条？', conversation: [{ role: 'user', content: '我接下来会问历史统计。' }, { role: 'assistant', content: '请说明需要核对的历史记录。' }] },
  { id: 'external', question: '请查询 Python 官方文档，解释字典的用途，提供官方页面链接。只需公开资料。' },
  { id: 'memory', question: '请通过 askMemory 的 memory 域查找我沉淀的记忆系统边界知识，说明查到的依据；没找到就说明缺口。' },
  { id: 'knowledge', question: '请通过 askMemory 的 knowledge 域查询知识库中关于智能体记忆的文档，不要用其他来源代替，提供查到的文档依据。' },
];
const ids = process.argv.find(arg => arg.startsWith('--ids='))?.slice(6).split(',');
const selected = cases.filter(row => (!ids || ids.includes(row.id)) && (!process.argv.includes('--internal-only') || row.id !== 'external'));
const sourceHashes = Object.fromEntries(['lib/ai/memory-access.ts', 'lib/ai/evidence-window.ts', 'lib/ai/platform-source-reader.ts', 'lib/ai/native-pi-web-chat-tools.ts', 'lib/ai/unified-memory-tool.ts', 'lib/ai/public-page-reader.ts', 'lib/ai/knowledge-base-documents.ts', 'lib/ai/knowledge-keyword-search.ts', 'lib/brain/service.ts', 'lib/brain/recall-planner.ts', 'lib/workshops/pi-domain-tools.ts', 'app/api/native/agent/route.ts'].map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(root, 'apps/web', file))).digest('hex')]));
for (const file of ['lib/ai/brain-read-tools.ts', 'lib/ai/snapshot-catalog-reader.ts', 'lib/ai/snapshot-search-cursor.ts', 'lib/ai/snapshot-discovery.ts', 'lib/ai/snapshot-answer-checkpoint.ts', 'lib/ai/memory-read-budget.ts', 'lib/ai/platform-record-reader.ts', 'lib/ai/loop-task-read-tools.ts', 'lib/ai/loop-run-timeline-reader.ts', 'lib/ai/loop-runtime-observation.ts', 'lib/ai/loop-runtime-answer-guard.ts', 'lib/ai/platform-claim-boundary.ts', 'lib/ai/platform-recall.ts', 'lib/ai/jev-platform-prefetch.ts', 'lib/brain/repository.ts']) sourceHashes[file] = createHash('sha256').update(fs.readFileSync(path.join(root, 'apps/web', file))).digest('hex');
const evaluationHashes = Object.fromEntries(['scripts/validate-memory-access.mjs', 'scripts/lib/pi-memory-eval-request.mjs', 'scripts/lib/memory-evidence-audit.mjs'].map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(root, 'apps/web', file))).digest('hex')]));
fs.writeFileSync(path.join(out, 'run.json'), JSON.stringify({ url, provider, at: new Date().toISOString(), tools, cases: selected, sourceHashes, evaluationHashes, rubric: 'Completion is not factual accuracy. Offline field provenance is not semantic correctness. No golden answers injected.' }, null, 2));
for (const test of selected) {
  const record = { id: test.id, question: test.question, events: [], startedAt: new Date().toISOString() };
  try {
    const response = await fetch(`${url}/api/native/agent`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url }, signal: AbortSignal.timeout(180000),
      body: JSON.stringify({ ...buildMemoryEvalRequest(test, test.allowedTools ?? tools, provider), ...(test.conversation ? { conversation: test.conversation } : {}) }) });
    if (!response.ok) throw Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 800)}`);
    const decoder = new TextDecoder(); let buffer = '';
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true }).replace(/\r/g, '');
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        for (const line of frame.split('\n')) if (line.startsWith('data: ') && line.slice(6) !== '[DONE]') record.events.push(JSON.parse(line.slice(6)));
      }
    }
    record.completed = record.events.some(event => event.type === 'done') && record.events.some(event => event.type === 'result');
    record.answer = record.events.filter(event => event.type === 'text').map(event => event.content ?? event.text ?? '').join('');
    record.toolNames = record.events.filter(event => event.type === 'tool_use').map(event => event.name);
    record.errors = record.events.filter(event => event.type === 'error' || event.isError);
  } catch (error) { record.error = String(error); }
  const reviewed = auditMemoryEvidence(record.events);
  record.finalAnswer = reviewed.finalAnswer;
  record.evidenceAudit = reviewed.audit;
  fs.writeFileSync(path.join(out, `${test.id}.json`), JSON.stringify(record, null, 2));
  console.log(JSON.stringify({ id: test.id, completed: record.completed, tools: record.toolNames, errorCount: record.errors?.length, error: record.error }));
}
console.log(JSON.stringify({ out }));
