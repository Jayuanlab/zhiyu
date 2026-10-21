import type { AgentRuntimeRunSnapshot } from "@/lib/ai/runtime/run-snapshot";
import { parseAgentRuntimeRunSnapshot } from "@/lib/ai/runtime/run-snapshot";
import type { WorkshopEvent } from "@/lib/db/schema";

export interface WorkshopRuntimeRunSnapshotRef {
  eventId: string;
  createdAt: string;
  runId: string | null;
  loopId: string | null;
  loopRunId: string | null;
  snapshot: AgentRuntimeRunSnapshot;
}

function isoTime(value: Date | string | null | undefined): string {
  if (!value) return "";
  return value instanceof Date ? value.toISOString() : value;
}

function parseTime(value: Date | string | null | undefined): number {
  const timestamp = new Date(isoTime(value)).getTime();
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function extractWorkshopRuntimeRunSnapshot(
  event: Pick<
    WorkshopEvent,
    "id" | "createdAt" | "type" | "metadata" | "runId" | "loopId" | "loopRunId"
  >,
): WorkshopRuntimeRunSnapshotRef | null {
  if (event.type !== "agent_configured") return null;
  const metadata = asRecord(event.metadata);
  const snapshot = parseAgentRuntimeRunSnapshot(metadata.runtimeRunSnapshot);
  if (!snapshot) return null;
  return {
    eventId: event.id,
    createdAt: isoTime(event.createdAt),
    runId: event.runId ?? null,
    loopId: event.loopId ?? null,
    loopRunId: event.loopRunId ?? null,
    snapshot,
  };
}

export function latestWorkshopRuntimeRunSnapshot(
  events: Array<
    Pick<
      WorkshopEvent,
      "id" | "createdAt" | "type" | "metadata" | "runId" | "loopId" | "loopRunId"
    >
  >,
): WorkshopRuntimeRunSnapshotRef | null {
  return (
    events
      .map(extractWorkshopRuntimeRunSnapshot)
      .filter((item): item is WorkshopRuntimeRunSnapshotRef => Boolean(item))
      .sort((left, right) => parseTime(right.createdAt) - parseTime(left.createdAt))[0] ?? null
  );
}
