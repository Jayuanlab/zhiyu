const WORKSHOP_API_ERROR_MESSAGES: Record<string, string> = {
  target_busy: '该任务已经排队或正在运行，请在运行记录中查看进度，完成后再试。',
};

export function workshopApiErrorMessage(
  payload: unknown,
  fallback: string,
): string {
  if (!payload || typeof payload !== 'object') return fallback;
  const record = payload as Record<string, unknown>;
  const code = typeof record.code === 'string' ? record.code : '';
  if (code && WORKSHOP_API_ERROR_MESSAGES[code]) {
    return WORKSHOP_API_ERROR_MESSAGES[code];
  }
  return typeof record.error === 'string' && record.error.trim()
    ? record.error
    : fallback;
}
