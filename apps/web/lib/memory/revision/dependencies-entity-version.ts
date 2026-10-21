import { dependencyObject, getMemoryDependencyEntityVersion, type MemoryDependencyEntityKind } from "./dependencies-common";

/** Only real persisted content/definition fields contribute to this version. */
export type MemoryDependencyEntityRow = {
  id: string; userId: string;
  eventId?: unknown; threadId?: unknown; noteType?: unknown; title?: unknown; body?: unknown;
  description?: unknown; dueAt?: unknown; assigneeName?: unknown; requesterName?: unknown;
  confidence?: unknown; sourceEventIds?: unknown; metadata?: unknown;
  workshopId?: unknown; name?: unknown; goal?: unknown; triggerConfig?: unknown;
  contextConfig?: unknown; actionPolicy?: unknown; verificationConfig?: unknown;
  approvalPolicy?: unknown; retryPolicy?: unknown; escalationPolicy?: unknown;
};

function storedJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return undefined; }
}
function storedObject(value: unknown) { return dependencyObject(storedJson(value)); }
function observedDate(value: unknown) {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  return value;
}

export function getMemoryDependencyEntityProjectionFromRow(kind: MemoryDependencyEntityKind, row: MemoryDependencyEntityRow, loopState?: { stateJson?: unknown } | null): Record<string, unknown> {
  if (kind === "loop") {
    // Runtime state and pause/resume acknowledgements are not Loop definition.
    return { kind, id: row.id, userId: row.userId, workId: row.workshopId ?? null,
      name: row.name, description: row.description, goal: row.goal,
      triggerConfig: row.triggerConfig, contextConfig: row.contextConfig, actionPolicy: row.actionPolicy,
      verificationConfig: row.verificationConfig, approvalPolicy: row.approvalPolicy,
      retryPolicy: row.retryPolicy, escalationPolicy: row.escalationPolicy,
      loopSpec: storedObject(loopState?.stateJson).loopSpec ?? null };
  }
  const metadata = storedObject(row.metadata);
  const sourceIds = storedJson(row.sourceEventIds);
  const sourceEventIds = Array.isArray(sourceIds) ? sourceIds : [];
  if (kind === "wiki_note") return { kind, id: row.id, userId: row.userId, eventId: row.eventId, threadId: row.threadId,
    noteType: row.noteType, title: row.title, body: row.body, confidence: row.confidence, sourceEventIds, metadata };
  const understandingMetadata = { ...metadata };
  // Normal task acknowledgements do not change its reviewed understanding.
  delete understandingMetadata.taskActions;
  delete understandingMetadata.taskState;
  return { kind, id: row.id, userId: row.userId, eventId: row.eventId, threadId: row.threadId,
    title: row.title, description: row.description, dueAt: observedDate(row.dueAt), assigneeName: row.assigneeName,
    requesterName: row.requesterName, confidence: row.confidence, sourceEventIds, metadata: understandingMetadata };
}

/** Shared by database reads and the exact Wiki rows being sent to a model. */
export function getMemoryDependencyEntityVersionFromRow(kind: MemoryDependencyEntityKind, row: MemoryDependencyEntityRow, loopState?: { stateJson?: unknown } | null): string {
  return getMemoryDependencyEntityVersion(getMemoryDependencyEntityProjectionFromRow(kind, row, loopState));
}
