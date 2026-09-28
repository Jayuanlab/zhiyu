const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const uuidInText = /\b[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b/gi;

/** Offline provenance aid, never a semantic correctness score or model input. */
export function auditMemoryEvidence(events) {
  const finalResult = events.filter(e => e.type === 'result' && typeof e.content === 'string').at(-1);
  // Native Pi reports result.content='success' as a completion marker. The
  // user-visible answer is streamed through text events before that marker.
  const streamedText = events.filter(e => e.type === 'text' && typeof e.content === 'string')
    .map(e => e.content).join('');
  const answerSource = !finalResult ? 'missing_result'
    : finalResult.content === 'success' ? 'streamed_text' : 'final_result';
  const finalAnswer = !finalResult ? null
    : finalResult.content === 'success' ? (streamedText || null) : finalResult.content;
  const occurrences = new Map();
  const calls = new Map(events.filter(e => e.type === 'tool_use').map(e => [e.id ?? e.toolUseId, e.name]));
  let inspectedRecords = 0;
  let skippedResults = 0;
  let outputCharacters = 0;
  let assembledRecords = 0;
  const timelineWindows = [];
  const runtimeObservations = [];
  const exactPages = new Map();
  let currentExecutorUnobserved = false;
  let leaseHeartbeatNotEvaluated = false;
  function inspect(value, path, toolUseId) {
    if (typeof value === 'string' && uuid.test(value)) {
      const id = value.toLowerCase();
      const found = occurrences.get(id) ?? [];
      found.push({ toolUseId, path });
      occurrences.set(id, found);
    } else if (Array.isArray(value)) value.forEach((v, i) => inspect(v, `${path}[${i}]`, toolUseId));
    else if (value && typeof value === 'object') {
      for (const [key, v] of Object.entries(value)) inspect(v, `${path}.${key}`, toolUseId);
    }
  }
  for (const event of events.filter(e => e.type === 'tool_result')) {
    if (typeof event.output === 'string') outputCharacters += event.output.length;
    if (event.isError) { skippedResults++; continue; }
    let data;
    try { data = typeof event.output === 'string' ? JSON.parse(event.output) : event.output; }
    catch { skippedResults++; continue; }
    if (!data || data.ok === false) { skippedResults++; continue; }
    const name = calls.get(event.toolUseId);
    const roots = [];
    let supportedResult = false;
    if (name === 'platformRecall') {
      if (data.claimBoundary?.currentExecutor?.status === 'not_observed') currentExecutorUnobserved = true;
      if (Array.isArray(data.data?.brain?.snapshots)) {
        // Discovery wrappers are excerpts, not raw records; their read arguments are not field evidence.
        if (data.data.brain.snapshots.every(record => record && !record.representation)) roots.push(['data.brain.snapshots', data.data.brain.snapshots]);
      }
      if (Array.isArray(data.data?.records?.records)) roots.push(['data.records.records', data.data.records.records]);
      const timeline = data.data?.timeline ?? data.timeline ?? data;
      if (timeline?.status === 'read' && Array.isArray(timeline.runs) && typeof timeline.loopId === 'string'
        && typeof timeline.afterRunId === 'string' && timeline.coverage
        && typeof timeline.coverage.hasMore === 'boolean') {
        supportedResult = true;
        roots.push(['data.timeline.runs', timeline.runs]);
        timelineWindows.push({ loopId: timeline.loopId, afterRunId: timeline.afterRunId,
          cursorRunId: timeline.cursorRunId ?? null, returnedCount: timeline.runs.length,
          hasMore: timeline.coverage.hasMore, nextCursorRunId: timeline.coverage.nextCursorRunId ?? null,
          observedAt: timeline.observedAt ?? null, toolUseId: event.toolUseId });
      }
      const runtime = data.data?.runtimeObservation ?? data.runtime ?? data;
      if (runtime?.provider === 'workshop_execution_leases' && typeof runtime.status === 'string') {
        supportedResult = true;
        if (runtime.status !== 'active_lease_recent_heartbeat') currentExecutorUnobserved = true;
        if (runtime.status === 'no_active_linked_execution_observed') leaseHeartbeatNotEvaluated = true;
        runtimeObservations.push({ status: runtime.status, loopId: runtime.loopId ?? null,
          observedAt: runtime.observedAt ?? null, provider: runtime.provider, toolUseId: event.toolUseId });
      }
      if (data.status === 'read' && typeof data.source === 'string' && typeof data.id === 'string'
        && typeof data.contentHash === 'string' && Number.isSafeInteger(data.offset)
        && typeof data.content === 'string' && Number.isSafeInteger(data.totalCharacters)
        && (data.nextOffset === null || data.nextOffset === data.offset + data.content.length)) {
        supportedResult = true;
        const key = `${data.source}:${data.id}:${data.contentHash}`;
        const pages = exactPages.get(key) ?? [];
        pages.push({ offset: data.offset, content: data.content, nextOffset: data.nextOffset, total: data.totalCharacters, toolUseId: event.toolUseId });
        exactPages.set(key, pages);
      }
    } else if (name === 'brainListSnapshots') {
      if (Array.isArray(data.snapshots)) roots.push(['snapshots', data.snapshots]);
      // A complete exact read can be parsed as a record. Partial windows remain unverified here.
      if (data.status === 'read' && data.offset === 0 && data.nextOffset === null && typeof data.content === 'string') {
        try { roots.push(['content', [JSON.parse(data.content)]]); } catch { /* unsupported representation */ }
      }
    }
    if (!roots.length && !supportedResult) skippedResults++;
    for (const [path, records] of roots) {
      inspectedRecords += records.length;
      inspect(records, path, event.toolUseId);
    }
  }
  for (const [key, pages] of exactPages) {
    pages.sort((a, b) => a.offset - b.offset);
    let at = 0;
    let full = '';
    let complete = false;
    for (const page of pages) {
      if (page.offset !== at || (page.nextOffset !== null && page.nextOffset !== at + page.content.length)) break;
      full += page.content;
      at += page.content.length;
      if (page.nextOffset === null) { complete = at === page.total; break; }
    }
    if (!complete || createHash('sha256').update(full).digest('hex') !== key.split(':')[2]) continue;
    try {
      const record = JSON.parse(full);
      if (record?.source !== key.split(':')[0] || record?.id !== key.split(':')[1]) continue;
      assembledRecords++;
      inspectedRecords++;
      inspect(record, `recordRead[${key}]`, pages[0].toolUseId);
    } catch { /* Incomplete or unsupported representation is not evidence. */ }
  }
  const answerIds = [...new Set((finalAnswer?.match(uuidInText) ?? []).map(id => id.toLowerCase()))];
  const claimSentences = (finalAnswer ?? '').split(/[。！？\n]/u);
  const possibleLiveClaim = claimSentences.some(sentence =>
    !/能否|是否|吗\s*$/u.test(sentence) && (
    /(?:很可能|极可能|大概率|可能性很高).{0,40}(?:非活跃|阻塞|等待干预|仍处于|未运行|不在运行|停滞|已停止|中断)/u.test(sentence)
    || (!/不能|无法|不可|不应|不要|未验证|未知/u.test(sentence)
      && (/(?:此刻|现在|目前|当前).{0,35}(?:执行器|Loop).{0,35}(?:(?:仍|处于).{0,25}(?:阻塞|error|错误)|已停止|已停机|空闲|非活跃|不在运行)/iu.test(sentence)
        || /(?:无活动|没有活动|未观察到活动).{0,60}(?:所以|因此|说明|证明).{0,30}(?:已停止|不在运行|空闲|非活跃)/u.test(sentence)))));
  const claimRisks = [
    ...(currentExecutorUnobserved && possibleLiveClaim ? [{ code: 'possible_live_runtime_claim_from_persisted_state',
      detail: 'The answer may promote persisted state or a missing lease observation to a current executor state. Review the exact wording and available live observations.' }] : []),
    ...(leaseHeartbeatNotEvaluated && claimSentences.some(sentence =>
      !/(?:不能|不可|不应|严禁|不要).{0,30}(?:表述为|说成|写成|声称)/u.test(sentence)
      && !/(?:没有|未取得|无).{0,30}(?:租约|心跳).{0,20}(?:观测值|读数|读取结果)/u.test(sentence)
      && /(?:未观察到|未检测到|没有)(?:(?:活动|活跃)的?)?(?:执行器)?(?:租约|心跳)/u.test(sentence))
      ? [{ code: 'lease_heartbeat_absence_claim_without_evaluation',
        detail: 'No active linked execution mapping was found, so this read did not evaluate a lease or heartbeat. Do not claim either was absent.' }] : []),
  ];
  return {
    finalAnswer,
    audit: {
      status: finalAnswer === null ? 'missing_final_answer' : 'requires_claim_review',
      answerSource,
      inspectedRecords, assembledRecords, timelineWindows, runtimeObservations,
      claimRisks, skippedResults, outputCharacters,
      identifiers: answerIds.map(id => ({ id, occurrences: occurrences.get(id) ?? [],
        status: occurrences.has(id) ? 'observed_in_record_fields' : 'not_verified_by_this_audit' })),
      warning: 'Field occurrence does not prove the answer assigns the right role, time or meaning. Question echoes, requested IDs, prose and failed results are not evidence. Only supported raw-record shapes are inspected; unmatched IDs are unverified, not proven false. Human claim review is required.',
    },
  };
}
import { createHash } from 'node:crypto';
