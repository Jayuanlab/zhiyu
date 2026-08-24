import { auth } from "@/app/(auth)/auth";
import {
  readPageStateSnapshot,
  writePageStateSnapshot,
} from "@/lib/page-state/snapshots";
import { getWorkSummarySnapshot } from "@/lib/work-runtime";
import {
  summarySnapshotToPageState,
  withWorkshopSummaryCacheMeta,
  workshopSummaryPageStateKey,
  workshopSummaryPageStateStaleTtlMs,
  workshopSummaryPageStateTtlMs,
  type WorkshopSummaryPageState,
} from "@/lib/workshops/summary-page-state";
import { NextResponse, type NextRequest } from "next/server";

export const dynamic = "force-dynamic";

const summaryRefreshes = new Map<string, Promise<void>>();

function refreshKey(userId: string, workshopId: string) {
  return `${userId}:${workshopId}`;
}

async function persistWorkshopSummaryPageState(input: {
  userId: string;
  workshopId: string;
  value: WorkshopSummaryPageState;
}) {
  const generatedAt = new Date();
  const expiresAt = new Date(
    generatedAt.getTime() + workshopSummaryPageStateTtlMs(),
  );
  const staleUntil = new Date(
    expiresAt.getTime() + workshopSummaryPageStateStaleTtlMs(),
  );

  await writePageStateSnapshot({
    userId: input.userId,
    key: workshopSummaryPageStateKey(input.workshopId),
    value: input.value as unknown as Record<string, unknown>,
    meta: {
      source: "workshop-summary-page-state",
      generatedAt: generatedAt.toISOString(),
    },
    generatedAt,
    expiresAt,
    staleUntil,
  });
}

async function buildWorkshopSummaryPageState(input: {
  userId: string;
  workshopId: string;
}) {
  const snapshot = await getWorkSummarySnapshot({
    userId: input.userId,
    workId: input.workshopId,
  });
  return snapshot ? summarySnapshotToPageState(snapshot) : null;
}

async function refreshWorkshopSummaryPageState(input: {
  userId: string;
  workshopId: string;
}) {
  const key = refreshKey(input.userId, input.workshopId);
  const existing = summaryRefreshes.get(key);
  if (existing) return existing;

  const refresh = (async () => {
    const value = await buildWorkshopSummaryPageState(input);
    if (!value) return;
    await persistWorkshopSummaryPageState({
      ...input,
      value,
    });
  })().finally(() => {
    if (summaryRefreshes.get(key) === refresh) {
      summaryRefreshes.delete(key);
    }
  });
  summaryRefreshes.set(key, refresh);
  return refresh;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;
    const forceRefresh = request.nextUrl.searchParams.get("refresh") === "1";

    if (forceRefresh) {
      const value = await buildWorkshopSummaryPageState({
        userId: session.user.id,
        workshopId: id,
      });
      if (!value) {
        return NextResponse.json(
          { error: "Workshop not found" },
          { status: 404 },
        );
      }
      await persistWorkshopSummaryPageState({
        userId: session.user.id,
        workshopId: id,
        value,
      }).catch((error) => {
        console.warn("[WorkshopSummaryPageState] persist snapshot failed", {
          workshopId: id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      return NextResponse.json(value);
    }

    const persisted = await readPageStateSnapshot<WorkshopSummaryPageState>({
      userId: session.user.id,
      key: workshopSummaryPageStateKey(id),
    }).catch((error) => {
      console.warn("[WorkshopSummaryPageState] read snapshot failed", {
        workshopId: id,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    });

    if (persisted && persisted.staleUntil.getTime() >= Date.now()) {
      const stale = persisted.expiresAt.getTime() < Date.now();
      if (stale) {
        setTimeout(() => {
          void refreshWorkshopSummaryPageState({
            userId: session.user.id,
            workshopId: id,
          }).catch((error) => {
            console.warn("[WorkshopSummaryPageState] background refresh failed", {
              workshopId: id,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }, 0);
      }

      return NextResponse.json(
        withWorkshopSummaryCacheMeta({
          value: persisted.value,
          stale,
          refreshing: stale,
          generatedAt: persisted.generatedAt,
          expiresAt: persisted.expiresAt,
        }),
      );
    }

    const value = await buildWorkshopSummaryPageState({
      userId: session.user.id,
      workshopId: id,
    });
    if (!value) {
      return NextResponse.json(
        { error: "Workshop not found" },
        { status: 404 },
      );
    }

    await persistWorkshopSummaryPageState({
      userId: session.user.id,
      workshopId: id,
      value,
    }).catch((error) => {
      console.warn("[WorkshopSummaryPageState] persist snapshot failed", {
        workshopId: id,
        error: error instanceof Error ? error.message : String(error),
      });
    });

    return NextResponse.json(value);
  } catch (error) {
    console.error("[WorkshopSummaryPageState] GET error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to load workshop summary page state",
      },
      { status: 500 },
    );
  }
}
