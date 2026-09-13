import { auth } from "@/app/(auth)/auth";
import type { Workshop, WorkshopEvent } from "@/lib/db/schema";
import {
  readPageStateSnapshot,
  writePageStateSnapshot,
} from "@/lib/page-state/snapshots";
import { getWorkshopDashboard } from "@/lib/workshops/dashboard";
import { getCachedWorkshopDashboard } from "@/lib/workshops/dashboard-cache";
import {
  getCachedWorkshopPageState,
  putCachedWorkshopPageState,
  refreshCachedWorkshopPageState,
  setCachedWorkshopPageState,
  type WorkshopPageStateCacheHit,
  workshopPageStateCacheStaleTtlMs,
  workshopPageStateCacheTtlMs,
} from "@/lib/workshops/page-state-cache";
import { scheduleWorkshopDashboardWarmup } from "@/lib/workshops/page-state-warmup";
import { listWorkshops } from "@/lib/workshops/service";
import { NextResponse } from "next/server";

type WorkshopPageStateItem = {
  id: string;
  workshop: Workshop;
  name: string;
  mission: string;
  status: string;
  updatedAt: string;
  summary: {
    attentionCount?: number | null;
    activeLoops: number;
    pendingApprovals: number;
    blockedLoops: number;
    pendingOutbox: number;
    latestEventTitle: string | null;
    latestConclusion?: WorkshopEvent | null;
    latestEventBody: string | null;
    latestEventAt: string | null;
    nextWorkAt: string | null;
  };
  cache: {
    hit: boolean;
    stale: boolean;
    refreshing: boolean;
    warning?: string;
  };
};

type WorkshopPageStateResponse = {
  workshops: WorkshopPageStateItem[];
  selectedWorkshopId: string | null;
  meta: {
    generatedAt: string;
    hit: boolean;
    stale: boolean;
    refreshing: boolean;
    warnings: string[];
    cache?: {
      hit: boolean;
      stale: boolean;
      refreshing: boolean;
      fetchedAt: string;
      expiresAt: string;
    };
  };
};

const WORKSHOP_PAGE_STATE_KEY = "workshop:index:status-v1";

function isoTime(value: Date | string | null | undefined) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function stringMetadataValue(
  metadata: Record<string, unknown> | null | undefined,
  key: string,
) {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function eventSummaryText(
  event: { body: string | null; metadata: Record<string, unknown> } | null,
) {
  if (!event) return null;
  return stringMetadataValue(event.metadata, "summary") ?? event.body ?? null;
}

function eventSummaryTitle(
  event: {
    title: string;
    body: string | null;
    metadata: Record<string, unknown>;
  } | null,
) {
  if (!event) return null;
  const summary = eventSummaryText(event);
  if (
    summary &&
    (event.title === "Loop completed" || event.title === "Task completed")
  ) {
    return summary.split(/[。！？\n]/u)[0]?.trim() || event.title;
  }
  return event.title;
}

function configuredWarmupLimit() {
  const configured = Number(process.env.WORKSHOP_PAGE_STATE_WARMUP_LIMIT);
  return Number.isFinite(configured) && configured >= 0
    ? Math.floor(configured)
    : 1;
}

function fallbackItem(
  workshop: Workshop,
  warning?: string,
  refreshing = false,
): WorkshopPageStateItem {
  return {
    id: workshop.id,
    workshop,
    name: workshop.name,
    mission: workshop.mission,
    status: workshop.status,
    updatedAt: isoTime(workshop.updatedAt) ?? new Date().toISOString(),
    summary: {
      attentionCount: null,
      activeLoops: 0,
      pendingApprovals: 0,
      blockedLoops: 0,
      pendingOutbox: 0,
      latestEventTitle: null,
      latestEventBody: null,
      latestEventAt: null,
      nextWorkAt: null,
    },
    cache: {
      hit: false,
      stale: true,
      refreshing,
      warning,
    },
  };
}

function cacheHitFromDates(input: {
  value: WorkshopPageStateResponse;
  fetchedAt: Date;
  expiresAt: Date;
  staleUntil: Date;
}): WorkshopPageStateCacheHit<WorkshopPageStateResponse> {
  const now = Date.now();
  return {
    value: input.value,
    hit: true,
    stale: now > input.expiresAt.getTime(),
    refreshing: false,
    fetchedAt: input.fetchedAt.getTime(),
    expiresAt: input.expiresAt.getTime(),
  };
}

function withCacheMeta(
  value: WorkshopPageStateResponse,
  cached: WorkshopPageStateCacheHit<WorkshopPageStateResponse>,
): WorkshopPageStateResponse {
  return {
    ...value,
    meta: {
      ...value.meta,
      hit: true,
      stale: cached.stale || value.meta.stale,
      refreshing: cached.refreshing || cached.stale || value.meta.refreshing,
      warnings: cached.stale
        ? [
            "workshop page-state snapshot is stale; refreshing in background",
            ...value.meta.warnings,
          ]
        : value.meta.warnings,
      cache: {
        hit: true,
        stale: cached.stale,
        refreshing: cached.refreshing || cached.stale,
        fetchedAt: new Date(cached.fetchedAt).toISOString(),
        expiresAt: new Date(cached.expiresAt).toISOString(),
      },
    },
  };
}

async function persistWorkshopPageState(
  userId: string,
  value: WorkshopPageStateResponse,
) {
  const generatedAt = new Date();
  const expiresAt = new Date(
    generatedAt.getTime() + workshopPageStateCacheTtlMs(),
  );
  const staleUntil = new Date(
    expiresAt.getTime() + workshopPageStateCacheStaleTtlMs(),
  );

  await writePageStateSnapshot({
    userId,
    key: WORKSHOP_PAGE_STATE_KEY,
    value: value as unknown as Record<string, unknown>,
    meta: {
      source: "workshop-page-state",
      generatedAt: generatedAt.toISOString(),
    },
    generatedAt,
    expiresAt,
    staleUntil,
  });
}

async function buildAndPersistWorkshopPageState(
  userId: string,
): Promise<WorkshopPageStateResponse> {
  const body = await buildWorkshopPageState(userId);
  setCachedWorkshopPageState({
    userId,
    value: body,
  });
  await persistWorkshopPageState(userId, body).catch((error) => {
    console.warn("[WorkshopPageState] persist snapshot failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return body;
}

async function buildWorkshopPageState(
  userId: string,
): Promise<WorkshopPageStateResponse> {
  const workshops: Workshop[] = await listWorkshops(userId);
  const warnings: string[] = [];
  const warmupLimit = configuredWarmupLimit();
  let warmupsScheduled = 0;
  const items = workshops.map((workshop: Workshop) => {
    const cached = getCachedWorkshopDashboard({
      userId,
      workshopId: workshop.id,
    });

    if (!cached) {
      const scheduled =
        warmupsScheduled < warmupLimit &&
        scheduleWorkshopDashboardWarmup({
          userId,
          workshopId: workshop.id,
          run: () =>
            getWorkshopDashboard({
              userId,
              workshopId: workshop.id,
            }),
          onError: (error) => {
            console.warn("[WorkshopPageState] dashboard warmup failed", {
              workshopId: workshop.id,
              error: error instanceof Error ? error.message : String(error),
            });
          },
        });
      if (scheduled) warmupsScheduled += 1;
      warnings.push(
        scheduled
          ? `workshop ${workshop.id} dashboard is warming up`
          : `workshop ${workshop.id} dashboard snapshot is unavailable`,
      );
      return fallbackItem(
        workshop,
        scheduled ? "dashboard is refreshing" : "dashboard snapshot unavailable",
        scheduled,
      );
    }

    if (cached.stale) {
      const scheduled =
        warmupsScheduled < warmupLimit &&
        scheduleWorkshopDashboardWarmup({
          userId,
          workshopId: workshop.id,
          run: () =>
            getWorkshopDashboard({
              userId,
              workshopId: workshop.id,
            }),
        });
      if (scheduled) warmupsScheduled += 1;
      warnings.push(`workshop ${workshop.id} dashboard snapshot is stale`);
    }

    const dashboard = cached.dashboard;
    return {
      id: workshop.id,
      workshop,
      name: workshop.name,
      mission: workshop.mission,
      status: dashboard.status,
      updatedAt: isoTime(workshop.updatedAt) ?? new Date().toISOString(),
      summary: {
        attentionCount: dashboard.counts.attentionCount ?? null,
        activeLoops: dashboard.counts.activeLoops,
        pendingApprovals: dashboard.counts.pendingApprovals,
        blockedLoops: dashboard.counts.blockedLoops + dashboard.counts.errorLoops,
        pendingOutbox: dashboard.counts.pendingOutbox,
        latestEventTitle: eventSummaryTitle(dashboard.latestEvent),
        latestConclusion: dashboard.latestConclusion ?? null,
        latestEventBody: eventSummaryText(dashboard.latestEvent),
        latestEventAt: isoTime(dashboard.latestEvent?.createdAt) ?? null,
        nextWorkAt: dashboard.nextWork.at,
      },
      cache: {
        hit: true,
        stale: cached.stale,
        refreshing: cached.refreshing,
      },
    } satisfies WorkshopPageStateItem;
  });

  return {
    workshops: items,
    selectedWorkshopId: items[0]?.id ?? null,
    meta: {
      generatedAt: new Date().toISOString(),
      hit: true,
      stale: warnings.length > 0,
      refreshing: warnings.length > 0,
      warnings,
    },
  };
}

export async function GET(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (request && new URL(request.url).searchParams.get('refresh') === '1') {
      return NextResponse.json(await buildAndPersistWorkshopPageState(session.user.id), {headers:{'Cache-Control':'no-store'}});
    }
    const cached = getCachedWorkshopPageState<WorkshopPageStateResponse>(
      session.user.id,
    );
    if (cached) {
      if (cached.stale) {
        refreshCachedWorkshopPageState({
          userId: session.user.id,
          run: () => buildAndPersistWorkshopPageState(session.user.id),
        });
      }
      return NextResponse.json(withCacheMeta(cached.value, cached));
    }

    const persisted = await readPageStateSnapshot<WorkshopPageStateResponse>({
      userId: session.user.id,
      key: WORKSHOP_PAGE_STATE_KEY,
    }).catch((error) => {
      console.warn("[WorkshopPageState] read persisted snapshot failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    });

    if (persisted && persisted.staleUntil.getTime() >= Date.now()) {
      putCachedWorkshopPageState({
        userId: session.user.id,
        value: persisted.value,
        fetchedAt: persisted.generatedAt.getTime(),
        expiresAt: persisted.expiresAt.getTime(),
        staleUntil: persisted.staleUntil.getTime(),
      });
      const persistedHit = cacheHitFromDates({
        value: persisted.value,
        fetchedAt: persisted.generatedAt,
        expiresAt: persisted.expiresAt,
        staleUntil: persisted.staleUntil,
      });
      if (persistedHit.stale) {
        refreshCachedWorkshopPageState({
          userId: session.user.id,
          run: () => buildAndPersistWorkshopPageState(session.user.id),
        });
      }
      return NextResponse.json(withCacheMeta(persisted.value, persistedHit));
    }

    const body = await buildAndPersistWorkshopPageState(session.user.id);

    return NextResponse.json(body);
  } catch (error) {
    console.error("[WorkshopPageState] GET error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to load workshop page state",
      },
      { status: 500 },
    );
  }
}
