import type { BrainMemory } from "../kernel/memory-types";
import { resolveZhiyuMemoryPolicy } from "@/lib/memory-zhiyu/policy";
import { isPolicyTrace, type PolicyTrace } from "../../../../../packages/memory/src/policy";
import { extractedLessonOmitReason } from "./lesson-extraction";

export const RECORD_LIFECYCLE_VERSION = "memory-record-lifecycle.v1";
export type MemoryRecordClass = "long_term" | "run_record" | "acceptance_record";
export type RecordLifecycle = { schemaVersion: typeof RECORD_LIFECYCLE_VERSION; recordClass: MemoryRecordClass;
  reason: string; authority: "source_classification" | "owner_classification"; classifiedAt: string;
  usableUntil: string | null; retention: "preserve_audit"; commandId?: string; reviewBy?: string; policy?: PolicyTrace };
const classes = ["long_term", "run_record", "acceptance_record"];
export function storedRecordLifecycle(memory: Pick<BrainMemory, "metadata">): RecordLifecycle | null {
  const value = memory.metadata?.recordLifecycle as RecordLifecycle | undefined;
  return value?.schemaVersion === RECORD_LIFECYCLE_VERSION && classes.includes(value.recordClass)
    && typeof value.reason === "string" && ["source_classification", "owner_classification"].includes(value.authority)
    && Number.isFinite(Date.parse(value.classifiedAt)) && value.retention === "preserve_audit"
    && (value.usableUntil === null || typeof value.usableUntil === "string" && Number.isFinite(Date.parse(value.usableUntil)))
    && (value.reviewBy === undefined || typeof value.reviewBy === "string" && Number.isFinite(Date.parse(value.reviewBy)))
    && (value.policy === undefined || isPolicyTrace(value.policy)) ? value : null;
}
/** High precision source intent, never an arbitrary mention of checkpoint or acceptance. */
export function inferRecordClass(memory: BrainMemory): { recordClass: MemoryRecordClass; reason: string } {
 const decision=resolveZhiyuMemoryPolicy(memory); return {recordClass:decision.recordClass as MemoryRecordClass,reason:decision.reason};
}
export function makeRecordLifecycle(memory: BrainMemory, recordClass: MemoryRecordClass, reason: string, now: Date,
  commandId?: string): RecordLifecycle {
  const start = Date.parse(memory.createdAt);
  const decision = resolveZhiyuMemoryPolicy(memory);
  const windowMs = decision.runWindowMs;
  return { schemaVersion: RECORD_LIFECYCLE_VERSION, recordClass, reason,
    authority: commandId ? "owner_classification" : "source_classification", classifiedAt: now.toISOString(),
    usableUntil: recordClass === "run_record" && Number.isFinite(start) ? new Date(Math.min(start + windowMs, memory.expiresAt && Number.isFinite(Date.parse(memory.expiresAt)) ? Date.parse(memory.expiresAt) : Infinity)).toISOString() : null,
    retention: "preserve_audit", policy: decision.trace, ...(commandId ? { commandId } : {}) };
}
export function classifyNewRecord(memory: BrainMemory): BrainMemory {
  if (storedRecordLifecycle(memory)) return memory;
  const inferred = inferRecordClass(memory);
  if (inferred.recordClass === "long_term") return memory;
  return { ...memory, metadata: { ...memory.metadata, recordLifecycle: makeRecordLifecycle(memory, inferred.recordClass, inferred.reason, new Date(memory.createdAt)) } };
}
export function memoryRecallOmitReason(memory: BrainMemory): string | null {
  if (memory.metadata?.lessonExtraction && memory.status === "candidate") return "lesson_requires_owner_review";
  if ((memory.metadata?.admission as { source?: string } | undefined)?.source === "historical_long_term_intake.v1" && memory.status === "candidate") return "intake_requires_owner_review";
  const extractionOmit = extractedLessonOmitReason(memory);
  if (extractionOmit) return extractionOmit;
  const stored = storedRecordLifecycle(memory);
  if (memory.metadata?.recordLifecycle && !stored) return "record_lifecycle_invalid";
  const kind = stored?.recordClass ?? inferRecordClass(memory).recordClass;
  return kind === "long_term" ? null : `record_class:${kind}`;
}
export function recordLifecycleView(memory: BrainMemory, now = new Date()) {
  const stored = storedRecordLifecycle(memory);
  const invalid = Boolean(memory.metadata?.recordLifecycle) && !stored;
  const inferred = inferRecordClass(memory);
  const lifecycle = stored ?? makeRecordLifecycle(memory, inferred.recordClass, inferred.reason, new Date(memory.createdAt));
  return { ...lifecycle, ...(invalid ? { reason: "invalid_record_lifecycle" } : {}), persisted: Boolean(stored), phase: invalid ? "classification_unavailable" : lifecycle.reviewBy && Date.parse(lifecycle.reviewBy) <= now.getTime() || memory.metadata?.lessonExtraction && memory.expiresAt && Date.parse(memory.expiresAt) <= now.getTime() ? "review_expired" : memory.metadata?.lessonExtraction && extractedLessonOmitReason(memory) ? "source_changed" : lifecycle.recordClass === "acceptance_record" ? "audit_only"
    : lifecycle.recordClass === "long_term" ? "review_governed" : !lifecycle.usableUntil || Date.parse(lifecycle.usableUntil) <= now.getTime() ? "archived" : "continuity_window",
    recallEligible: memoryRecallOmitReason(memory) === null && ["active", "verified", "weakened"].includes(memory.status) && (!memory.expiresAt || Date.parse(memory.expiresAt) > now.getTime()) && (!lifecycle.reviewBy || Date.parse(lifecycle.reviewBy) > now.getTime()) };
}
