import type {
  LoopApprovalRequest,
  WorkshopEvent,
  WorkshopOutboxItem,
} from "@/lib/db/schema";
import {
  summarizeLoop,
  summarizeLoopRun,
  type LoopDashboardDetail,
} from "@/lib/loops/dashboard";
import {
  getLoopInWorkshop,
  getLoopState,
  listLoopApprovalRequests,
  listLoopRuns,
} from "@/lib/loops/service";
import { listWorkshopEvents, listWorkshopOutbox } from "./service";

export interface WorkshopLoopDetail {
  loop: LoopDashboardDetail;
  events: WorkshopEvent[];
  memoryRecall: Array<{
    eventId: string;
    createdAt: string;
    backend: string;
    contextLogId: string | null;
    recallPlan: unknown;
    explanation: unknown;
    contextPack: unknown;
    routeResults: unknown;
    fallbackReason: string | null;
    error: string | null;
  }>;
  approvalRequests: LoopApprovalRequest[];
  outbox: WorkshopOutboxItem[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function timeMs(value: Date | string | null | undefined) {
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

function eventMetadata(event: WorkshopEvent) {
  return asRecord(event.metadata);
}

function eventString(event: WorkshopEvent, key: string) {
  return stringValue(eventMetadata(event)[key]);
}

function dateIso(value: Date | string | null | undefined) {
  if (!value) return "";
  return value instanceof Date ? value.toISOString() : String(value);
}

function selectWorkshopLoopMemoryRecall(events: WorkshopEvent[]) {
  return events
    .map((event) => {
      const memoryRecall = asRecord(eventMetadata(event).memoryRecall);
      const backend = stringValue(memoryRecall.backend);
      if (!backend) return null;
      return {
        eventId: event.id,
        createdAt: dateIso(event.createdAt),
        backend,
        contextLogId: stringValue(memoryRecall.contextLogId),
        recallPlan: memoryRecall.recallPlan ?? null,
        explanation: memoryRecall.explanation ?? memoryRecall.selection ?? null,
        contextPack: memoryRecall.contextPack ?? null,
        routeResults: memoryRecall.routeResults ?? [],
        fallbackReason: stringValue(memoryRecall.fallbackReason),
        error: stringValue(memoryRecall.error),
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);
}

function sourceEventIds(item: WorkshopOutboxItem) {
  return Array.isArray(item.sourceEventIds)
    ? item.sourceEventIds.filter(
        (eventId): eventId is string =>
          typeof eventId === "string" && Boolean(eventId.trim()),
      )
    : [];
}

export function selectWorkshopLoopEvents(input: {
  loopId: string;
  loopRunIds: Set<string>;
  events: WorkshopEvent[];
}) {
  return input.events
    .filter((event) => {
      const metadataLoopId = eventString(event, "loopId");
      const metadataLoopRunId = eventString(event, "loopRunId");
      return (
        event.loopId === input.loopId ||
        metadataLoopId === input.loopId ||
        (event.loopRunId !== null && input.loopRunIds.has(event.loopRunId)) ||
        (metadataLoopRunId !== null && input.loopRunIds.has(metadataLoopRunId))
      );
    })
    .sort(
      (a, b) =>
        b.seq - a.seq || timeMs(b.createdAt) - timeMs(a.createdAt),
    );
}

export function selectWorkshopLoopOutbox(input: {
  loopEvents: WorkshopEvent[];
  outbox: WorkshopOutboxItem[];
}) {
  const loopEventIds = new Set(input.loopEvents.map((event) => event.id));
  const outboxIds = new Set(
    input.loopEvents
      .map((event) => eventString(event, "outboxId"))
      .filter((id): id is string => id !== null),
  );

  return input.outbox
    .filter(
      (item) =>
        outboxIds.has(item.id) ||
        sourceEventIds(item).some((eventId) => loopEventIds.has(eventId)),
    )
    .sort(
      (a, b) =>
        timeMs(b.createdAt) - timeMs(a.createdAt) ||
        a.id.localeCompare(b.id),
    );
}

export async function getWorkshopLoopDetail(input: {
  userId: string;
  workshopId: string;
  loopId: string;
}): Promise<WorkshopLoopDetail | null> {
  const loop = await getLoopInWorkshop(input);
  if (!loop) return null;

  const [state, runs, events, approvalRequests, outbox] = await Promise.all([
    getLoopState(loop.id),
    listLoopRuns(loop.id, { limit: 25 }),
    listWorkshopEvents(input.workshopId, { limit: 300, order: "latest" }),
    listLoopApprovalRequests(input.userId, {
      loopId: loop.id,
      limit: 100,
    }),
    listWorkshopOutbox(input.workshopId, 200),
  ]);

  const loopRunIds = new Set(runs.map((run) => run.id));
  const loopEvents = selectWorkshopLoopEvents({
    loopId: loop.id,
    loopRunIds,
    events,
  });

  return {
    loop: {
      ...summarizeLoop({
        loop,
        state,
        latestRun: runs[0] ?? null,
      }),
      contextConfig: loop.contextConfig,
      actionPolicy: loop.actionPolicy,
      verificationConfig: loop.verificationConfig,
      approvalPolicy: loop.approvalPolicy,
      retryPolicy: loop.retryPolicy,
      escalationPolicy: loop.escalationPolicy,
      runs: runs.map((run) => summarizeLoopRun(run)),
    },
    events: loopEvents,
    memoryRecall: selectWorkshopLoopMemoryRecall(loopEvents),
    approvalRequests,
    outbox: selectWorkshopLoopOutbox({
      loopEvents,
      outbox,
    }),
  };
}
