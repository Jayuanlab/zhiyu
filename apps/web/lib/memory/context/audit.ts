import type { BrainContextLog, InsertBrainContextLog } from "@/lib/db/schema";
import { deserializeJson } from "@/lib/db/serialization";
import { withMemoryRecordWrite } from "../revision/transaction";
import { contextLogToInsertRow, type ContextLogWrite } from "../records/context-log";
import type { BrainRecallQualityLog as ContextQualityLog } from "../governance/recall-quality";
import { insertContextLogInTransaction, completeContextAuditInTransaction, readContextLogsForQuality } from "../adapters/postgres/context-logs";
import type { BrainRequester } from "../kernel/memory-types";
import type { BrainContextPack } from "./pack";

export type ContextLogProjection = { requester: BrainRequester; pack: BrainContextPack; taskIntent?: string | null; metadata?: Record<string, unknown> };
export function contextLogProjection(input: ContextLogProjection): ContextLogWrite {
  return { userId: input.requester.userId, requesterType: input.requester.type,
    requesterId: input.requester.id ?? input.requester.workId ?? null, taskIntent: input.taskIntent ?? null,
    selectedMemoryIds: input.pack.items.map(item => item.id), denied: input.pack.denied, omitted: input.pack.omitted,
    metadata: { ...input.metadata, selectedMemoryVersions: input.pack.items.filter(item => typeof item.revisionVersion === "string")
      .map(item => ({ memoryId: item.id, revisionVersion: item.revisionVersion })) } };
}
export function brainContextLogToInsertRow(input: ContextLogProjection): InsertBrainContextLog {
  return contextLogToInsertRow(contextLogProjection(input));
}
export async function insertBrainContextLog(input: ContextLogProjection): Promise<BrainContextLog> {
  return withMemoryRecordWrite(input.requester.userId, "context_log", async store => {
    const created = await insertContextLogInTransaction(store, contextLogProjection(input));
    return { id: created.id, result: created };
  });
}
async function completeAudit(input: { userId: string; contextLogId: string; outcome: Record<string, unknown> }, key: "evidenceReadOutcome" | "queryRetryOutcome") {
  return withMemoryRecordWrite(input.userId, "context_log", async store => {
    const result = await completeContextAuditInTransaction(store, { ...input, key });
    return { id: input.contextLogId, result: { recorded: true }, written: result.written };
  });
}
export const completeBrainEvidenceAudit = (input: { userId: string; contextLogId: string; outcome: Record<string, unknown> }) => completeAudit(input, "evidenceReadOutcome");
export const completeBrainRecallRetryAudit = (input: { userId: string; contextLogId: string; outcome: Record<string, unknown> }) => completeAudit(input, "queryRetryOutcome");

function decoded(value: unknown): unknown { return deserializeJson(value as Parameters<typeof deserializeJson>[0]); }
function object(value: unknown): Record<string, unknown> { const data = decoded(value); return data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {}; }
function array(value: unknown): unknown[] { const data = decoded(value); return Array.isArray(data) ? data : []; }
function strings(value: unknown): string[] { return array(value).filter((item): item is string => typeof item === "string"); }
export function brainContextLogToQualityLog(row: BrainContextLog): ContextQualityLog {
  const metadata = object(row.metadata), planner = object(metadata.recallPlanner), omitted = array(row.omitted);
  const audit = metadata.evidenceReadOutcome, counts: Record<string, number> = {};
  for (const route of array(planner.routes)) {
    const value = object(route);
    if (value.enabled !== false && typeof value.route === "string") counts[value.route] = (counts[value.route] ?? 0) + 1;
  }
  const time = row.createdAt instanceof Date ? row.createdAt : new Date(String(row.createdAt));
  return { id: row.id, evidenceReadAudit: audit && typeof audit === "object" && !Array.isArray(audit)
      ? { status: (audit as Record<string, unknown>).status, quality: (audit as Record<string, unknown>).quality } : audit,
    requesterType: row.requesterType as BrainRequester["type"], requesterId: row.requesterId ?? null,
    selectedMemoryIds: strings(row.selectedMemoryIds), deniedCount: array(row.denied).length, omittedCount: omitted.length,
    duplicateCanonicalGroupCount: omitted.filter(item => object(item).reason === "duplicate_canonical_group").length,
    recallProfileIds: strings(metadata.recallProfileIds), recallProfileIssueCount: strings(metadata.recallProfileIssueCodes).length,
    recallPlannerMode: ["rules", "llm", "fallback_rules", "jev"].includes(String(planner.mode)) ? planner.mode as ContextQualityLog["recallPlannerMode"] : "unknown",
    recallPlannerWarningCount: strings(planner.warnings).length, recallRouteCounts: counts, createdAt: Number.isFinite(time.getTime()) ? time.toISOString() : "" };
}
export async function listBrainContextLogsForQuality(input: { userId: string; limit?: number }): Promise<ContextQualityLog[]> {
  return (await readContextLogsForQuality(input)).map(brainContextLogToQualityLog);
}
