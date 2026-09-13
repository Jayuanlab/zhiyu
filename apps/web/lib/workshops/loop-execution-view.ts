const BUSY_RUN_STATUSES = new Set([
  'queued',
  'running',
  'cancel_requested',
  'needs_review',
]);

export function loopExecutionView(input: {
  localPending: boolean;
  latestRunStatus?: string | null;
}) {
  if (input.localPending) return { busy: true, actionLabel: '提交中' };
  if (input.latestRunStatus === 'queued') {
    return { busy: true, actionLabel: '已排队' };
  }
  if (input.latestRunStatus === 'cancel_requested') {
    return { busy: true, actionLabel: '停止中' };
  }
  if (input.latestRunStatus === 'needs_review') {
    return { busy: true, actionLabel: '待处理' };
  }
  if (input.latestRunStatus === 'running') {
    return { busy: true, actionLabel: '运行中' };
  }
  return {
    busy: BUSY_RUN_STATUSES.has(input.latestRunStatus ?? ''),
    actionLabel: '运行一次',
  };
}
