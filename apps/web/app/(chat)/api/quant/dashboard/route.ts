import { auth } from "@/app/(auth)/auth";
import { fetchQuantDashboard } from "@/lib/quant/client";
import { cachedQuantRead } from "@/lib/quant/cache";
import {
  persistQuantDashboardSnapshot,
  readPersistedQuantDashboard,
} from "@/lib/quant/direct-snapshot";
import { NextResponse } from "next/server";

const DASHBOARD_TIMEOUT_MS = 800;
const DASHBOARD_PENDING = Symbol("dashboard-pending");

function configuredTimeout() {
  const configured = Number(process.env.QUANT_DIRECT_DASHBOARD_TIMEOUT_MS);
  return Number.isFinite(configured) && configured >= 0
    ? configured
    : DASHBOARD_TIMEOUT_MS;
}

function withTimeout<T>(promise: Promise<T>) {
  return Promise.race<T | typeof DASHBOARD_PENDING>([
    promise,
    new Promise<typeof DASHBOARD_PENDING>((resolve) => {
      setTimeout(() => resolve(DASHBOARD_PENDING), configuredTimeout());
    }),
  ]);
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const dashboardPromise = cachedQuantRead({
      key: "quant:dashboard",
      fetcher: fetchQuantDashboard,
    });
    dashboardPromise.catch(() => undefined);

    const persisted = await readPersistedQuantDashboard({
      userId: session.user.id,
      warning:
        "Quant dashboard is refreshing in background; returning persisted snapshot.",
    });
    if (persisted) {
      void dashboardPromise
        .then((dashboard) =>
          persistQuantDashboardSnapshot({
            userId: session.user.id,
            dashboard,
          }),
        )
        .catch(() => undefined);
      return NextResponse.json(persisted);
    }

    const dashboard = await withTimeout(dashboardPromise);
    if (dashboard === DASHBOARD_PENDING) {
      const stale = await readPersistedQuantDashboard({
        userId: session.user.id,
        warning:
          "Quant dashboard refresh is still running; returning persisted snapshot.",
      });
      if (stale) return NextResponse.json(stale);
      throw new Error("Quant dashboard refresh timed out");
    }

    await persistQuantDashboardSnapshot({
      userId: session.user.id,
      dashboard,
    }).catch(() => undefined);
    return NextResponse.json(dashboard);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Quant service unavailable";
    return NextResponse.json(
      {
        error: message,
        hint: "Start tools/quant-service or set QUANT_SERVICE_URL.",
      },
      { status: 503 },
    );
  }
}
