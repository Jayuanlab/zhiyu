import { createHash } from 'node:crypto';

export const WORKING_MEMORY_LOG_TRIGGERS = [
  'subgoal_completed', 'source_coverage_completed', 'correction_received', 'context_pressure',
] as const;
export type WorkingMemoryLogTrigger = typeof WORKING_MEMORY_LOG_TRIGGERS[number];

/** This contract controls notes only. It never grants a tool or source permission. */
export interface WorkingMemoryStrategy {
  schemaVersion: 'working-memory-strategy.v1';
  version: string;
  noteFormat: 'facts-hypotheses-questions-next-action.v1';
  index: 'stable-key';
  deduplication: 'normalized-text-evidence' | 'exact-text-evidence';
  logTriggers: WorkingMemoryLogTrigger[];
  retrieval: { order: 'evidence-first' | 'recent-first'; maxNotes: number };
  budget: { maxEdits: number; maxSummaryChars: number; maxReadCalls: number };
}

export const DEFAULT_WORKING_MEMORY_STRATEGY: Readonly<WorkingMemoryStrategy> = Object.freeze({
  schemaVersion: 'working-memory-strategy.v1',
  version: 'memact-automem.v1',
  noteFormat: 'facts-hypotheses-questions-next-action.v1',
  index: 'stable-key',
  deduplication: 'normalized-text-evidence',
  logTriggers: Object.freeze([...WORKING_MEMORY_LOG_TRIGGERS]) as unknown as WorkingMemoryLogTrigger[],
  retrieval: Object.freeze({ order: 'evidence-first', maxNotes: 16 }),
  budget: Object.freeze({ maxEdits: 4, maxSummaryChars: 6_000, maxReadCalls: 16 }),
});

function plain(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) && Reflect.ownKeys(value).every(key =>
    typeof key === 'string' && keys.includes(key) && !Object.getOwnPropertyDescriptor(value, key)?.get);
}
const bounded = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;

export function canonicalWorkingMemoryStrategy(strategy: WorkingMemoryStrategy): string {
  return JSON.stringify({
    schemaVersion: strategy.schemaVersion, version: strategy.version, noteFormat: strategy.noteFormat,
    index: strategy.index, deduplication: strategy.deduplication,
    logTriggers: WORKING_MEMORY_LOG_TRIGGERS.filter(trigger => strategy.logTriggers.includes(trigger)),
    retrieval: { order: strategy.retrieval.order, maxNotes: strategy.retrieval.maxNotes },
    budget: { maxEdits: strategy.budget.maxEdits, maxSummaryChars: strategy.budget.maxSummaryChars, maxReadCalls: strategy.budget.maxReadCalls },
  });
}

export function workingMemoryStrategyIdentity(strategy: WorkingMemoryStrategy) {
  return { version: strategy.version, hash: createHash('sha256').update(canonicalWorkingMemoryStrategy(strategy)).digest('hex') };
}

export function readWorkingMemoryPolicyBinding(value: unknown, workshopId: string, identity: { version: string; hash: string }) {
  if (value === undefined || value === null) return { valid: true, status: 'unbound' as const, issues: [] as string[] };
  const keys = ['schemaVersion', 'status', 'workshopId', 'version', 'hash', 'proposalId', 'campaignId', 'commandId', 'appliedBy', 'appliedAt', 'previous'];
  if (!plain(value, keys)) return { valid: false, status: 'invalid' as const, issues: ['invalid_memory_binding_shape'] };
  const issues: string[] = [];
  if (value.schemaVersion !== 'memory-policy-binding.v1' || value.status !== 'active') issues.push('invalid_memory_binding_state');
  if (value.workshopId !== workshopId) issues.push('memory_binding_scope_mismatch');
  if (value.version !== identity.version || value.hash !== identity.hash) issues.push('memory_binding_identity_mismatch');
  for (const key of ['proposalId', 'campaignId', 'commandId', 'appliedBy', 'appliedAt']) {
    if (typeof value[key] !== 'string' || !String(value[key]).trim()) issues.push(`missing_memory_binding_${key}`);
  }
  return { valid: issues.length === 0, status: issues.length ? 'invalid' as const : 'active' as const, issues };
}

export function resolveWorkingMemoryStrategy(value: unknown) {
  const issues: string[] = [];
  const keys = ['schemaVersion', 'version', 'noteFormat', 'index', 'deduplication', 'logTriggers', 'retrieval', 'budget'];
  const present = value !== undefined && value !== null;
  if (present) {
    if (!plain(value, keys) || Reflect.ownKeys(value).length !== keys.length) issues.push('invalid_strategy_shape');
    else {
      if (value.schemaVersion !== 'working-memory-strategy.v1') issues.push('unsupported_strategy_schema');
      if (typeof value.version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$/.test(value.version)) issues.push('invalid_strategy_version');
      if (value.noteFormat !== 'facts-hypotheses-questions-next-action.v1' || value.index !== 'stable-key') issues.push('unsupported_note_format');
      if (!['normalized-text-evidence', 'exact-text-evidence'].includes(String(value.deduplication))) issues.push('invalid_deduplication');
      if (!Array.isArray(value.logTriggers) || value.logTriggers.length === 0 || value.logTriggers.length > 4
        || new Set(value.logTriggers).size !== value.logTriggers.length
        || !value.logTriggers.every(trigger => WORKING_MEMORY_LOG_TRIGGERS.includes(trigger as WorkingMemoryLogTrigger))) issues.push('invalid_log_triggers');
      if (!plain(value.retrieval, ['order', 'maxNotes']) || Reflect.ownKeys(value.retrieval).length !== 2
        || !['evidence-first', 'recent-first'].includes(String(value.retrieval.order))
        || !bounded(value.retrieval.maxNotes, 1, 56)) issues.push('invalid_retrieval');
      if (!plain(value.budget, ['maxEdits', 'maxSummaryChars', 'maxReadCalls']) || Reflect.ownKeys(value.budget).length !== 3
        || !bounded(value.budget.maxEdits, 1, 16) || !bounded(value.budget.maxSummaryChars, 256, 12_000)
        || !bounded(value.budget.maxReadCalls, 1, 32)) issues.push('invalid_budget');
    }
  }
  const strategy = structuredClone((issues.length || !present ? DEFAULT_WORKING_MEMORY_STRATEGY : value) as WorkingMemoryStrategy);
  // Invalid input retains a readable built-in identity but callers must keep the tool off.
  return { strategy, identity: workingMemoryStrategyIdentity(strategy), issues, source: present ? 'configured' as const : 'builtin' as const };
}

export function formatWorkingMemoryStrategyGuidance(strategy: WorkingMemoryStrategy): string {
  const identity = workingMemoryStrategyIdentity(strategy);
  return `本轮记忆策略 ${identity.version}，hash=${identity.hash}，运行期间固定版本。
LOG：在 ${strategy.logTriggers.join('、')} 出现且进度有新增或变化时，先用 operation=read 获取当前目录与 version，查询已有笔记，再用 operation=update、phase=LOG 保存简短完整状态后继续交付；没有变化时可以不写，不为凑轮次增加记录。facts、hypotheses、openQuestions、nextAction 分开；note.key 是同一条笔记的稳定索引，纠错时修订原 key，不重复追加相同结论。不得把来源自己的报告写成已核实事实。
PLAN：行动前按子目标用 operation=read、query 查询必要笔记；最多返回 ${strategy.retrieval.maxNotes} 条，排序为 ${strategy.retrieval.order}。根据证据目录确认来源，缺关键依据时恢复或补读。evidenceCatalog 中 referenceEligible 允许引用，projectionCandidates 才允许 pruneToolCallIds；原文保留不妨碍记录有来源的笔记，阻断原因必须保留。
仅对子问题已完成且不再需要全文的合格来源请求正文投影，保留调用身份、thinking、来源 hash 和警告；恢复使用原 transcript，不重跑工具。目录查询最多 ${strategy.budget.maxReadCalls} 次，整理最多 ${strategy.budget.maxEdits} 次、状态最多 ${strategy.budget.maxSummaryChars} 字符，仍计入本轮总工具预算。不要求每轮整理或压缩。`;
}

/** One readback for both prompt assembly and the runtime permission gate. */
export function resolveWorkingMemoryActivation(modelConfig: unknown, workshopId: string) {
  const config = modelConfig && typeof modelConfig === 'object' && !Array.isArray(modelConfig)
    ? modelConfig as Record<string, unknown> : {};
  const resolved = resolveWorkingMemoryStrategy(config.memoryUsageContract);
  const binding = readWorkingMemoryPolicyBinding(config.memoryPolicyBinding, workshopId, resolved.identity);
  const issues = [...resolved.issues, ...binding.issues];
  if (resolved.source === 'configured' && binding.status === 'unbound'
    && resolved.identity.hash !== workingMemoryStrategyIdentity(structuredClone(DEFAULT_WORKING_MEMORY_STRATEGY)).hash) {
    issues.push('memory_strategy_not_activated');
  }
  return { ...resolved, issues, bindingStatus: binding.status };
}
