export type PendingRecallFeedback = {
  feedbackId: string; contextLogId?: string | null; query: string;
  outcome: string; reason: string; sources: string[];
};
export const feedbackRecoveryKey = (owner: string) => `recall-feedback-pending:v1:${owner}`;
export function readPendingRecallFeedback(storage: Pick<Storage, 'getItem'>, owner: string): PendingRecallFeedback | null {
  const raw = storage.getItem(feedbackRecoveryKey(owner));
  if (!raw) return null;
  const item = JSON.parse(raw);
  if (!item || typeof item.feedbackId !== 'string' || !/^[0-9a-f-]{36}$/i.test(item.feedbackId)
    || typeof item.query !== 'string' || typeof item.outcome !== 'string'
    || typeof item.reason !== 'string' || !Array.isArray(item.sources)
    || !item.sources.every((source: unknown) => typeof source === 'string')
    || (item.contextLogId != null && typeof item.contextLogId !== 'string'))
    throw Error('Invalid saved feedback');
  return item;
}
