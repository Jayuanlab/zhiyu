type MemoryUseDetailsProps = {
  applicability?: unknown;
  useSemantics?: unknown;
  status?: string;
};

const USE_LABELS: Record<string, string> = {
  constraint: '行为限制', state_estimate: '历史状态估计', plan: '计划记录',
  commitment: '承诺记录，履约需查任务', conditional_lesson: '有适用条件的经验', interpretation: '来源理解',
};

const STATUS_LABELS: Record<string, string> = {
  candidate: '待审核', active: '生效', verified: '已审核', weakened: '弱化',
  superseded: '已被新版本替代', deleted: '已停用',
};

/** Pure display: applicability describes relevance and cannot grant access. */
export function MemoryUseDetails({ applicability, useSemantics, status }: MemoryUseDetailsProps) {
  const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const scope = record(applicability), use = record(useSemantics);
  const keys = Array.isArray(scope.scenarioKeys) ? scope.scenarioKeys.filter((key): key is string => typeof key === 'string').slice(0, 16) : [];
  const label = scope.status === 'global' ? '主人确认的通用适用范围'
    : scope.status === 'scoped' ? '指定场景适用' : '适用范围待核对';
  return <div className="mt-2 min-w-0 space-y-1 break-words text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">
    <p>{label}{keys.length ? `：${keys.join('、')}` : ''}</p>
    <p>{USE_LABELS[typeof use.kind === 'string' ? use.kind : ''] ?? '历史记忆，使用前核对来源'}{status ? ` · 记录状态：${STATUS_LABELS[status] ?? '待核对'}` : ''}</p>
    <p>检索命中不代表本次任务适用，也不证明当前业务状态或授予执行权限。</p>
  </div>;
}
