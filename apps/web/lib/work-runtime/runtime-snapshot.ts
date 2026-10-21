// Compatibility entry; persistence and projection live in Memory.
export { parseWorkRunReviewRuntimeSnapshot, summarizeWorkRunReviewRuntimeSnapshot, extractWorkRunRuntimeSnapshotSummary, compareWorkRunRuntimeSnapshotSummaries, persistWorkRunRuntimeSnapshot, readWorkRunRuntimeSnapshotSummary } from "@/lib/memory/continuity/runtime-snapshot";
export type { WorkRunRuntimeSnapshotRef, WorkRunRuntimeSnapshotAuditSummary, PersistWorkRunRuntimeSnapshotInput } from "@/lib/memory/continuity/runtime-snapshot";
