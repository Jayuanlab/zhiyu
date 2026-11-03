import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import {
  encryptToken,
  decryptToken,
} from '@openzhiyu/security/token-encryption';
import { dailyFeedback } from './schema';
import { DayError } from './contracts';
export const encodeFeedback = (value: unknown) =>
  encryptToken(JSON.stringify(value));
const decode = <T>(value: string): T => JSON.parse(decryptToken(value));
export type FeedbackRecord = {
  id: string;
  date: string;
  workId: string;
  runId: string | null;
  status: string;
  text: string;
  origin: string;
  result: any;
  error: string | null;
  createdAt: string;
};
export async function listDailyFeedback(
  owner: string,
  store: any = db,
  all = false,
): Promise<FeedbackRecord[]> {
  const rows = await store
    .select()
    .from(dailyFeedback)
    .where(eq(dailyFeedback.ownerId, owner))
    .orderBy(desc(dailyFeedback.createdAt), desc(dailyFeedback.id))
    .limit(all ? 100000 : 200);
  if (all && rows.length === 100000)
    throw new DayError('export_limit_reached', 413);
  return rows.map((row: any) => ({
    id: row.id,
    date: row.date,
    workId: row.workId,
    runId: row.runId,
    status: row.status,
    text: decode<{ text: string }>(row.input).text,
    origin:
      decode<any>(row.input).origin ??
      (decode<any>(row.input).sourceId ? 'source' : 'feedback'),
    result: row.result ? decode(row.result) : null,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
  }));
}
export async function ownedFeedback(
  owner: string,
  id: string,
  store: any = db,
) {
  const [row] = await store
    .select()
    .from(dailyFeedback)
    .where(and(eq(dailyFeedback.ownerId, owner), eq(dailyFeedback.id, id)));
  if (!row) throw new DayError('feedback_not_found', 404);
  return {
    row,
    input: decode<{
      text: string;
      sourceId?: string;
      retryOf?: string;
      origin?: string;
    }>(row.input),
    text: decode<{ text: string }>(row.input).text,
    result: row.result ? decode<any>(row.result) : null,
  };
}
