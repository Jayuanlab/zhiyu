import type { BrainContextPack, BrainContextPackItem } from './context';

export type MemoryCategory = 'platform' | 'tools' | 'user' | 'task' | 'knowledge' | 'experience';
export type InformationStatus = 'present' | 'unverified' | 'stale' | 'conflict' | 'missing' | 'denied' | 'unavailable';
export type InformationNeed = {
  id: string;
  category: MemoryCategory;
  question: string;
  required: boolean;
  /** Optional task-specific facets; category membership alone cannot satisfy these. */
  matchTerms?: string[];
  /** Set by the caller, never by recalled text. */
  maxAgeHours?: number;
};
export type InformationReadiness = {
  version: 'information-readiness.v1';
  checkedAt: string;
  phase: string;
  assessment: 'evidence_inventory_only';
  needs: Array<InformationNeed & {
    status: InformationStatus;
    memoryIds: string[];
    evidenceRefs: string[];
    nextAction: 'use_evidence' | 'verify_source' | 'targeted_recall' | 'refresh_source' | 'respect_denial' | 'recover_source';
  }>;
  unresolvedRequired: string[];
  sourceWarnings: string[];
  followUp: { maxAdditionalRecalls: number; queries: string[] };
};

const categories: MemoryCategory[] = ['platform', 'tools', 'user', 'task', 'knowledge', 'experience'];
const terms: Record<MemoryCategory, RegExp> = {
  platform: /平台|操作|日志|审计|platform|activity|audit/i,
  tools: /工具|调用|回执|tool|receipt/i,
  user: /用户|偏好|联系人|关系|user|preference|contact/i,
  task: /任务|进度|续跑|恢复|计划|task|resume|plan/i,
  knowledge: /架构|规则|知识|配置|原理|architecture|rule|knowledge|config/i,
  experience: /经验|反馈|失败|复盘|重试|feedback|failure|retry|lesson/i,
};
const descriptions: Record<MemoryCategory, string> = {
  platform: '相关平台操作和原始事件', tools: '相关工具调用结果和执行回执',
  user: '相关用户偏好和关系', task: '当前任务进度、约束和待办',
  knowledge: '相关知识、架构和规则', experience: '相关失败、纠错和反馈',
};

const recallTerms: Record<MemoryCategory, string[]> = {
  platform: ['平台操作', '事件', '审计'], tools: ['工具调用', '回执', '执行结果'],
  user: ['用户偏好', '联系人', '关系'], task: ['任务状态', '进度', '待办'],
  knowledge: ['架构', '知识', '规则'], experience: ['失败', '纠错', '反馈'],
};

export function informationNeedRetry(need: InformationNeed) {
  return { query: need.question, searchTerms: need.matchTerms?.length ? need.matchTerms : recallTerms[need.category],
    reason: `required_information_missing:${need.id}` };
}

/** Routing hints only: an unmentioned category remains visible but is not mandatory. */
export function inferInformationNeeds(taskIntent: string): InformationNeed[] {
  return categories.map(category => ({
    id: category, category, question: `${descriptions[category]}：${taskIntent.slice(0, 300)}`,
    required: terms[category].test(taskIntent),
    ...(['platform', 'tools', 'task'].includes(category) ? { maxAgeHours: 24 } : {}),
  }));
}

function matches(item: BrainContextPackItem, category: MemoryCategory) {
  if (category === 'user' && ['preference', 'relationship'].includes(item.memoryType)) return true;
  if (category === 'task' && ['task', 'plan'].includes(item.memoryType)) return true;
  if (category === 'knowledge' && ['boundary', 'system'].includes(item.memoryType)) return true;
  if (category === 'experience' && item.canonicalKind === 'lesson') return true;
  // Content is deliberately excluded: a quotation must not classify itself as a receipt.
  return terms[category].test(item.subject);
}

/** Inventory of authorized evidence, not a semantic answer judge or an action permission. */
export function buildInformationReadiness(input: {
  taskIntent: string;
  phase?: string;
  needs?: InformationNeed[];
  pack: BrainContextPack;
  routes?: Array<{ route: string; status: string; error?: string; results?: Array<{ id: string; metadata?: Record<string, unknown> }> }>;
  now?: Date;
  additionalRecallBudget?: number;
}): InformationReadiness {
  const now = input.now ?? new Date();
  const routes = input.routes ?? [];
  const resolved = new Set(routes.flatMap(route => route.route === 'evidence_read'
    ? (route.results ?? []).filter(result => result.metadata?.evidenceStatus === 'resolved').map(result => result.id) : []));
  const denied = new Set(input.pack.denied.map(item => item.id));
  const sourceWarnings = routes.filter(route => ['failed', 'degraded'].includes(route.status))
    .map(route => `${route.route}:${route.status}`);
  if (denied.size) sourceWarnings.push('Some memories were denied; no category or content inferred from denied records.');
  const needs = (input.needs ?? inferInformationNeeds(input.taskIntent)).slice(0, 24).map(need => {
    const candidates = input.pack.items.filter(item => matches(item, need.category)
      && (!need.matchTerms?.length || need.matchTerms.every(term => `${item.subject}\n${item.content}`.toLowerCase().includes(term.toLowerCase()))));
    const items = candidates.filter(item => !denied.has(item.id));
    const conflicts = new Set((input.pack.warnings ?? []).filter(w => w.code === 'potential_state_conflict').flatMap(w => w.memoryIds));
    const isStale = (item: BrainContextPackItem) => {
      if (need.maxAgeHours === undefined) return false;
      const time = Date.parse(item.freshness?.updatedAt ?? '');
      return !Number.isFinite(time) || time > now.getTime() || (now.getTime() - time) / 3_600_000 > need.maxAgeHours;
    };
    let status: InformationStatus;
    if (candidates.some(item => denied.has(item.id))) status = 'denied';
    else if (!items.length) status = routes.some(route => ['failed', 'degraded'].includes(route.status)
      && (route.route === 'brain_memory' || (need.category === 'knowledge' && route.route === 'knowledge_store')
        || (need.category === 'user' && route.route === 'memory_graph'))) ? 'unavailable' : 'missing';
    else if (items.some(item => conflicts.has(item.id) || item.warnings?.includes('content_reports_conflict'))) status = 'conflict';
    else if (items.every(isStale)) status = 'stale';
    else if (items.some(item => !isStale(item) && item.evidenceRefs.some(ref => resolved.has(ref)))) status = 'present';
    else status = routes.some(route => route.route === 'evidence_read' && route.status === 'failed') ? 'unavailable' : 'unverified';
    const nextAction = ({ present: 'use_evidence', unverified: 'verify_source', stale: 'refresh_source', conflict: 'refresh_source', missing: 'targeted_recall', denied: 'respect_denial', unavailable: 'recover_source' } as const)[status];
    return { ...need, status, memoryIds: items.map(item => item.id), evidenceRefs: [...new Set(items.flatMap(item => item.evidenceRefs))], nextAction };
  });
  const requestedBudget = input.additionalRecallBudget ?? 0;
  const budget = Number.isFinite(requestedBudget) ? Math.min(1, Math.max(0, Math.floor(requestedBudget))) : 0;
  return {
    version: 'information-readiness.v1', checkedAt: now.toISOString(), phase: input.phase ?? 'recall',
    assessment: 'evidence_inventory_only', needs,
    unresolvedRequired: needs.filter(need => need.required && need.status !== 'present').map(need => need.id),
    sourceWarnings,
    followUp: { maxAdditionalRecalls: budget, queries: needs.filter(need => need.required && need.status === 'missing').slice(0, budget).map(need => need.question) },
  };
}

export function formatInformationReadiness(readiness: InformationReadiness) {
  return [
    'Information needs (evidence inventory; present does not prove answer completeness or authorize actions):',
    ...readiness.needs.map(need => `- ${need.category}: ${need.status}; required=${need.required}; next=${need.nextAction}; refs=${need.evidenceRefs.slice(0, 4).join(',') || 'none'}; ${need.question}`),
    `Unresolved required: ${readiness.unresolvedRequired.join(', ') || 'none'}`,
    `Source warnings: ${readiness.sourceWarnings.join('; ') || 'none'}`,
    `Additional recall budget: ${readiness.followUp.maxAdditionalRecalls}. Do not broaden permissions or repeat failed queries.`,
    'Before relying on unresolved information, read authorized current sources or report the precise gap. Before an external action, use live domain policy, approval and execution receipts. A retry must check the previous receipt before repeating a write.',
  ].join('\n');
}

export function unavailableInformationReadiness(taskIntent: string, phase: string): InformationReadiness {
  return buildInformationReadiness({ taskIntent, phase, pack: {
    interfaceVersion: 'brain-context.v1', items: [], denied: [], omitted: [],
    selection: { selectedCount: 0, deniedCount: 0, omittedCount: 0, duplicateCanonicalGroupCount: 0, selectedCanonicalKinds: {} },
  }, routes: [{ route: 'brain_memory', status: 'failed' }] });
}
