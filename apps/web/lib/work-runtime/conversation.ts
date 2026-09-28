import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { workshopRuns } from "@/lib/db/schema";
import { getWorkshop } from "@/lib/workshops/service";
import { parseConversationInputFiles } from "@/lib/workshops/conversation-input";
import { buildWorkConversationTurn, type WorkConversationResponse, type WorkConversationRun } from "@/lib/workshops/work-conversation";
import type { WorkPresentationEvent } from "@/lib/workshops/work-presentation";
import { startWorkRun } from "./commands";
import { getWorkCommand, WorkCommandConflict } from "./command-ledger";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TURN_LIMIT = 30;
const EVENT_LIMIT = 300;

export class WorkConversationValidationError extends Error {}

async function requireConversationWork(userId: string, workId: string) {
  if (!UUID.test(workId)) throw new WorkCommandConflict("not_found");
  const workshop = await getWorkshop(userId, workId);
  if (!workshop) throw new WorkCommandConflict("not_found");
  return workshop;
}

async function getConversationRun(workId: string, runId: string): Promise<WorkConversationRun | null> {
  const rows = await db.select().from(workshopRuns).where(and(
    eq(workshopRuns.workshopId, workId), eq(workshopRuns.id, runId),
    sql`${workshopRuns.triggerReason}->>'type' = 'conversation'`,
  )).limit(1);
  return (rows[0] as WorkConversationRun | undefined) ?? null;
}

/** A single bounded query keeps polling independent of total Work history.
 * The lateral limit applies to each run, rather than starving older turns. */
async function presentTurns(workId: string, runs: WorkConversationRun[]) {
  if (!runs.length) return [];
  const ids = sql.join(runs.map(run => sql`${run.id}::uuid`), sql`, `);
  const rows = await db.execute(sql`
    SELECT event.id, event.run_id AS "runId", event.seq, event.type,
      event.title, event.body, event.metadata, event.visibility,
      event.created_at AS "createdAt"
    FROM workshop_runs run
    CROSS JOIN LATERAL (
      SELECT e.* FROM workshop_events e
      WHERE e.workshop_id = ${workId}::uuid AND e.run_id = run.id
        AND e.visibility <> 'debug'
      ORDER BY e.seq DESC LIMIT ${EVENT_LIMIT + 1}
    ) event
    WHERE run.workshop_id = ${workId}::uuid AND run.id IN (${ids})
    ORDER BY event.run_id, event.seq ASC
  `);
  const grouped = new Map<string, WorkPresentationEvent[]>();
  for (const row of rows) {
    const event = row as unknown as WorkPresentationEvent;
    if (!event.runId) continue;
    const bucket = grouped.get(event.runId) ?? [];
    bucket.push(event);
    grouped.set(event.runId, bucket);
  }
  return runs.map(run => {
    const events = grouped.get(run.id) ?? [];
    return buildWorkConversationTurn({ workId, run,
      events: events.slice(-EVENT_LIMIT), hasMoreEvents: events.length > EVENT_LIMIT });
  });
}

export async function listWorkConversation(input: { userId: string; workId: string }): Promise<WorkConversationResponse> {
  await requireConversationWork(input.userId, input.workId);
  const rows = await db.select().from(workshopRuns).where(and(
    eq(workshopRuns.workshopId, input.workId),
    sql`${workshopRuns.triggerReason}->>'type' = 'conversation'`,
  )).orderBy(desc(workshopRuns.createdAt), desc(workshopRuns.id)).limit(TURN_LIMIT + 1);
  const runs = (rows as WorkConversationRun[]).slice(0, TURN_LIMIT).reverse();
  return { version: 1, workId: input.workId,
    turns: await presentTurns(input.workId, runs), hasMore: rows.length > TURN_LIMIT };
}

export async function submitWorkConversation(input: {
  userId: string; workId: string; commandId: unknown; content: unknown; parentRunId?: unknown;
}) {
  if (typeof input.commandId !== "string" || !UUID.test(input.commandId)) {
    throw new WorkConversationValidationError("请提供有效的任务编号。");
  }
  if (typeof input.content !== "string" || !input.content.trim() || input.content.trim().length > 12_000) {
    throw new WorkConversationValidationError("请输入 1 至 12000 字的任务内容。");
  }
  if (input.parentRunId != null && (typeof input.parentRunId !== "string" || !UUID.test(input.parentRunId))) {
    throw new WorkConversationValidationError("继续对话的任务编号无效。");
  }
  const workshop = await requireConversationWork(input.userId, input.workId);
  // Recover accepted requests even if the owner paused the Work after sending.
  // Payload identity is still checked by startWorkRun's command ledger.
  const existingCommand = await getWorkCommand(input.userId, input.commandId.toLowerCase());
  if (workshop.status !== "active" && !existingCommand) throw new WorkCommandConflict("target_busy");
  const parentRunId = typeof input.parentRunId === "string" ? input.parentRunId.toLowerCase() : null;
  if (parentRunId && !await getConversationRun(input.workId, parentRunId)) {
    throw new WorkConversationValidationError("只能继续当前智能体空间内已有的对话。");
  }
  const content = input.content.trim();
  let inputFiles: string[];
  try { inputFiles = parseConversationInputFiles(content); }
  catch (error) { throw new WorkConversationValidationError(error instanceof Error ? error.message : "文件路径无法识别。"); }
  const result = await startWorkRun({
    userId: input.userId, workId: input.workId,
    commandId: input.commandId.toLowerCase(), source: "owner",
    reason: "Temporary task submitted in Work conversation.",
    triggerReason: { type: "conversation", content, parentRunId, inputFiles },
  });
  // A retry reuses the accepted run but reads its current state, not the queued
  // snapshot that lives in the immutable command receipt.
  const run = await getConversationRun(input.workId, result.run.id);
  if (!run) throw new WorkCommandConflict("not_found");
  const [turn] = await presentTurns(input.workId, [run]);
  return { turn };
}
