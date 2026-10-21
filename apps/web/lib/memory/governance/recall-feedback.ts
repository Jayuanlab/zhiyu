import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { brainContextLogs, feedback } from '@/lib/db/schema';
import { deserializeJson, serializeJson } from '@/lib/db/serialization';
import { withMemoryRecordWrite as withBrainRecordWrite } from "../revision/transaction";
import { BRAIN_RECALL_FEEDBACK_OUTCOMES } from './recall-quality';

export const recallFeedbackInput = z.object({
  feedbackId: z.string().uuid(),
  contextLogId: z.string().uuid().nullish().transform(value => value ?? null),
  query: z.string().trim().min(1).max(500),
  outcome: z.enum(BRAIN_RECALL_FEEDBACK_OUTCOMES),
  reason: z.string().trim().max(1000).optional().default(''),
  sources: z.array(z.string().max(80)).max(10).default([]),
});
export class RecallFeedbackError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}
function record(value: any): Record<string, any> {
  const parsed = deserializeJson(value);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}
function list(value: any): any[] {
  const parsed = deserializeJson(value);
  return Array.isArray(parsed) ? parsed : [];
}

/** Freeze associations from the owner's recall snapshot; retries cannot append votes. */
export async function recordRecallFeedback(input: z.input<typeof recallFeedbackInput> & {
  userId: string; contactEmail?: string | null;
}) {
  const request = recallFeedbackInput.parse(input);
  const requestHash = createHash('sha256').update(JSON.stringify(request)).digest('hex');
  return withBrainRecordWrite(input.userId, 'review', async store => {
    const replay = async () => {
      const [existing] = await store.select().from(feedback)
        .where(eq(feedback.id, request.feedbackId)).for('update');
      if (!existing) return null;
      if (existing.userId !== input.userId) throw new RecallFeedbackError(404, 'Feedback unavailable.');
      if (existing.source !== 'memory_recall' || record(existing.systemInfo).requestHash !== requestHash)
        throw new RecallFeedbackError(409, 'Feedback ID already used for another request.');
      return { id: existing.id, result: { id: existing.id }, written: false };
    };
    const previous = await replay();
    if (previous) return previous;
    let context: any = null;
    if (request.contextLogId) {
      [context] = await store.select().from(brainContextLogs).where(and(
        eq(brainContextLogs.id, request.contextLogId), eq(brainContextLogs.userId, input.userId),
      )).for('share');
      if (!context) throw new RecallFeedbackError(404, 'Recall context unavailable.');
    }
    const selected = list(context?.selectedMemoryIds).filter(id => typeof id === 'string');
    const ids = (value: any) => list(value).map(item => item?.id).filter(id => typeof id === 'string');
    const reason = request.reason || `Unified memory recall ${request.outcome}`;
    const [created] = await store.insert(feedback).values({
      id: request.feedbackId, userId: input.userId, contactEmail: input.contactEmail ?? null,
      content: reason, type: 'improvement', title: `Memory recall ${request.outcome}`,
      description: reason, status: 'open',
      priority: ['missed_boundary', 'wrong_scope'].includes(request.outcome) ? 'high' : 'medium',
      source: 'memory_recall', updatedAt: new Date(),
      systemInfo: serializeJson({
        kind: 'memory_recall_feedback', requestHash, query: context?.taskIntent ?? request.query,
        reportedQuery: request.query, outcome: request.outcome, contextLogId: request.contextLogId,
        associationStatus: context ? 'verified_context' : 'unlinked',
        memoryIds: selected, selectedMemoryIds: selected,
        omittedMemoryIds: ids(context?.omitted), deniedMemoryIds: ids(context?.denied),
        sources: request.sources, automaticPolicyChange: false,
      }),
    }).onConflictDoNothing().returning();
    if (created) return { id: created.id, result: { id: created.id } };
    const concurrent = await replay();
    if (concurrent) return concurrent;
    throw new Error('Feedback receipt missing');
  });
}
