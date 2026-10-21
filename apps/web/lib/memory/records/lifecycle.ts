import type { BrainMemory } from "../kernel/memory-types";
import { analyzeOperationalContent } from "./operational-content";
import { extractedLessonOmitReason } from "./lesson-extraction";

export const RECORD_LIFECYCLE_VERSION = "memory-record-lifecycle.v1";
export type MemoryRecordClass = "long_term" | "run_record" | "acceptance_record";
export type RecordLifecycle = { schemaVersion: typeof RECORD_LIFECYCLE_VERSION; recordClass: MemoryRecordClass;
  reason: string; authority: "source_classification" | "owner_classification"; classifiedAt: string;
  usableUntil: string | null; retention: "preserve_audit"; commandId?: string; reviewBy?: string };
const classes = ["long_term", "run_record", "acceptance_record"];
export function storedRecordLifecycle(memory: Pick<BrainMemory, "metadata">): RecordLifecycle | null {
  const value = memory.metadata?.recordLifecycle as RecordLifecycle | undefined;
  return value?.schemaVersion === RECORD_LIFECYCLE_VERSION && classes.includes(value.recordClass)
    && typeof value.reason === "string" && ["source_classification", "owner_classification"].includes(value.authority)
    && Number.isFinite(Date.parse(value.classifiedAt)) && value.retention === "preserve_audit"
    && (value.usableUntil === null || typeof value.usableUntil === "string" && Number.isFinite(Date.parse(value.usableUntil)))
    && (value.reviewBy === undefined || typeof value.reviewBy === "string" && Number.isFinite(Date.parse(value.reviewBy))) ? value : null;
}
/** High precision source intent, never an arbitrary mention of checkpoint or acceptance. */
export function inferRecordClass(memory: BrainMemory): { recordClass: MemoryRecordClass; reason: string } {
  if (memory.memoryType === "boundary" || memory.metadata?.canonicalKind === "boundary") return { recordClass: "long_term", reason: "protected_boundary" };
  const facets = memory.metadata?.facets as Record<string, unknown> | undefined;
  const promotion = memory.metadata?.workingMemoryPromotion as Record<string, unknown> | undefined;
  if (/^Memory continuity acceptance [a-f0-9]{8} \/ acceptance\.policy$/.test(memory.subject)
    && memory.content.startsWith("memory-continuity-acceptance;") && facets?.notebookKey === "acceptance.policy"
    && typeof promotion?.commandId === "string" && promotion.commandId.startsWith("memory-continuity:"))
    return { recordClass: "acceptance_record", reason: "scoped_continuity_acceptance_fixture" };
  if (memory.ownerType === "work" && ["work", "workshop"].includes(memory.scope.type) && ["insight", "fact"].includes(memory.memoryType)) {
    const tags = new Set(memory.tags ?? []), head = memory.content.slice(0, 180);
    const authoredCheckpoint = tags.has("checkpoint") && (tags.has("research-state") || tags.has("daily-audit") || tags.has("threshold-review") || tags.has("recall-quality"));
    const datedCheckpoint = /^(?:\d{4}-\d{2}(?:-\d{2})?[^\n]{0,45}(?:研究检查点|质量审计检查点)|每日 Harness 质量审计检查点 \d{4}-|(?:Baseline checkpoint|Checkpoint|Threshold review checkpoint) \d{4}-)/i.test(head);
    const datedAudit = /^\d{4}-\d{2}-\d{2}\s/.test(head) && (tags.has("daily-audit") && /每日 Harness 质量审计/.test(head)
      || tags.has("threshold-review") && /阈值复核/.test(head));
    const datedProposalReceipt = tags.has("recall-quality") && tags.has("change-proposal") && /^Change proposal \d{4}-\d{2}-\d{2}/.test(head);
    if (authoredCheckpoint || datedCheckpoint || datedAudit || datedProposalReceipt) return { recordClass: "run_record", reason: "authored_operational_checkpoint" };
  }
  const operational = analyzeOperationalContent(memory);
  return operational ? { recordClass: "run_record", reason: operational.reason } : { recordClass: "long_term", reason: "no_operational_source_proof" };
}
export function makeRecordLifecycle(memory: BrainMemory, recordClass: MemoryRecordClass, reason: string, now: Date,
  commandId?: string): RecordLifecycle {
  const start = Date.parse(memory.createdAt);
  const operational = analyzeOperationalContent(memory);
  const windowMs = operational ? 86400_000 : 7 * 86400_000;
  return { schemaVersion: RECORD_LIFECYCLE_VERSION, recordClass, reason,
    authority: commandId ? "owner_classification" : "source_classification", classifiedAt: now.toISOString(),
    usableUntil: recordClass === "run_record" && Number.isFinite(start) ? new Date(Math.min(start + windowMs, memory.expiresAt && Number.isFinite(Date.parse(memory.expiresAt)) ? Date.parse(memory.expiresAt) : Infinity)).toISOString() : null,
    retention: "preserve_audit", ...(commandId ? { commandId } : {}) };
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
