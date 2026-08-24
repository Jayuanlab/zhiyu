import { auth } from "@/app/(auth)/auth";
import {
  readPageStateSnapshot,
  writePageStateSnapshot,
} from "@/lib/page-state/snapshots";
import { cachedQuantRead } from "@/lib/quant/cache";
import { fetchQuantDashboard, fetchQuantPaperAccount } from "@/lib/quant/client";
import { mergeQuantPageStateWithPrevious } from "@/lib/quant/page-state";
import type {
  QuantDashboard,
  QuantPageState,
  QuantPaperAccount,
} from "@/lib/quant/types";
import { NextResponse } from "next/server";

const DASHBOARD_TIMEOUT_MS = 450;
const ACCOUNT_TIMEOUT_MS = 450;
const QUANT_PAGE_STATE_KEY = "quant:index";
const QUANT_PAGE_STATE_TTL_MS = 5_000;
const QUANT_PAGE_STATE_STALE_TTL_MS = 2 * 60_000;

const DASHBOARD_PENDING = Symbol("dashboard-pending");
const ACCOUNT_PENDING = Symbol("account-pending");
const quantPageStateRefreshes = new Map<string, Promise<void>>();

function configuredTimeout(name: string, fallback: number) {
  const configured = Number(process.env[name]);
  return Number.isFinite(configured) && configured >= 0
    ? configured
    : fallback;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function pageStateTtlMs() {
  const configured = Number(process.env.QUANT_PAGE_STATE_CACHE_TTL_MS);
  return Number.isFinite(configured) && configured >= 0
    ? configured
    : QUANT_PAGE_STATE_TTL_MS;
}

function pageStateStaleTtlMs() {
  const configured = Number(process.env.QUANT_PAGE_STATE_CACHE_STALE_TTL_MS);
  return Number.isFinite(configured) && configured >= 0
    ? configured
    : QUANT_PAGE_STATE_STALE_TTL_MS;
}

function withTimeout<T, P extends symbol>(promise: Promise<T>, ms: number, pending: P) {
  return Promise.race<T | P>([
    promise,
    new Promise<P>((resolve) => {
      setTimeout(() => resolve(pending), ms);
    }),
  ]);
}

function withPersistentCacheMeta(input: {
  body: QuantPageState;
  stale: boolean;
  refreshing: boolean;
  generatedAt: Date;
  expiresAt: Date;
}): QuantPageState {
  return {
    ...input.body,
    meta: {
      ...input.body.meta,
      warnings: input.stale
        ? [
            "quant page-state snapshot is stale; refreshing in background",
            ...input.body.meta.warnings,
          ]
        : input.body.meta.warnings,
      cache: {
        hit: true,
        stale: input.stale,
        refreshing: input.refreshing,
        fetchedAt: input.generatedAt.toISOString(),
        expiresAt: input.expiresAt.toISOString(),
      },
    },
  };
}

async function persistQuantPageState(userId: string, body: QuantPageState) {
  const generatedAt = new Date();
  const expiresAt = new Date(generatedAt.getTime() + pageStateTtlMs());
  const staleUntil = new Date(expiresAt.getTime() + pageStateStaleTtlMs());
  const previous = await readPageStateSnapshot<QuantPageState>({
    userId,
    key: QUANT_PAGE_STATE_KEY,
  }).catch(() => null);
  const value = mergeQuantPageStateWithPrevious({
    current: body,
    previous: previous?.value ?? null,
  });

  await writePageStateSnapshot({
    userId,
    key: QUANT_PAGE_STATE_KEY,
    value: value as unknown as Record<string, unknown>,
    meta: {
      source: "quant-page-state",
      generatedAt: generatedAt.toISOString(),
    },
    generatedAt,
    expiresAt,
    staleUntil,
  });
}

async function buildQuantPageState(): Promise<QuantPageState> {
  const warnings: string[] = [];

  const accountPromise = cachedQuantRead({
    key: "quant:paper:account",
    fetcher: fetchQuantPaperAccount,
  });
  accountPromise.catch(() => undefined);

  const dashboardPromise = cachedQuantRead({
    key: "quant:dashboard",
    fetcher: fetchQuantDashboard,
  });
  dashboardPromise.catch(() => undefined);

  const [accountResult, dashboardResult] = await Promise.allSettled([
    withTimeout(
      accountPromise,
      configuredTimeout(
        "QUANT_PAGE_STATE_ACCOUNT_TIMEOUT_MS",
        ACCOUNT_TIMEOUT_MS,
      ),
      ACCOUNT_PENDING,
    ),
    withTimeout(
      dashboardPromise,
      configuredTimeout(
        "QUANT_PAGE_STATE_DASHBOARD_TIMEOUT_MS",
        DASHBOARD_TIMEOUT_MS,
      ),
      DASHBOARD_PENDING,
    ),
  ]);

  let account: QuantPaperAccount | null = null;
  let dashboard: QuantDashboard | null = null;
  const accountMeta: QuantPageState["meta"]["account"] = { ok: false };
  const dashboardMeta: QuantPageState["meta"]["dashboard"] = { ok: false };

  if (accountResult.status === "fulfilled") {
    if (accountResult.value === ACCOUNT_PENDING) {
      accountMeta.error = "account refresh is still running";
      accountMeta.refreshing = true;
      warnings.push("quant account is still refreshing in background");
    } else {
      account = accountResult.value;
      accountMeta.ok = true;
      accountMeta.stale = account.cache?.stale;
      accountMeta.refreshing = account.cache?.refreshing;
      if (account.cache?.warning) warnings.push(account.cache.warning);
    }
  } else {
    accountMeta.error = errorMessage(accountResult.reason);
    warnings.push(`quant account unavailable: ${accountMeta.error}`);
  }

  if (dashboardResult.status === "fulfilled") {
    if (dashboardResult.value === DASHBOARD_PENDING) {
      dashboardMeta.pending = true;
      dashboardMeta.error = "dashboard refresh is still running";
      warnings.push("quant dashboard is still refreshing in background");
    } else {
      dashboard = dashboardResult.value;
      dashboardMeta.ok = true;
      dashboardMeta.stale = dashboard.cache?.stale;
      dashboardMeta.refreshing = dashboard.cache?.refreshing;
      if (dashboard.cache?.warning) warnings.push(dashboard.cache.warning);
    }
  } else {
    dashboardMeta.error = errorMessage(dashboardResult.reason);
    warnings.push(`quant dashboard unavailable: ${dashboardMeta.error}`);
  }

  const body: QuantPageState = {
    account,
    dashboard,
    meta: {
      generated_at: new Date().toISOString(),
      account: accountMeta,
      dashboard: dashboardMeta,
      warnings,
    },
  };

  return body;
}

async function refreshQuantPageStateSnapshot(userId: string) {
  const existing = quantPageStateRefreshes.get(userId);
  if (existing) return existing;

  const refresh = (async () => {
    const body = await buildQuantPageState();
    await persistQuantPageState(userId, body);
  })().finally(() => {
    if (quantPageStateRefreshes.get(userId) === refresh) {
      quantPageStateRefreshes.delete(userId);
    }
  });
  quantPageStateRefreshes.set(userId, refresh);
  return refresh;
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const persisted = await readPageStateSnapshot<QuantPageState>({
    userId: session.user.id,
    key: QUANT_PAGE_STATE_KEY,
  }).catch((error) => {
    console.warn("[QuantPageState] read persisted snapshot failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  });

  if (persisted && persisted.staleUntil.getTime() >= Date.now()) {
    const stale = persisted.expiresAt.getTime() < Date.now();
    if (stale) {
      setTimeout(() => {
        void refreshQuantPageStateSnapshot(session.user.id).catch((error) => {
          console.warn("[QuantPageState] background refresh failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }, 0);
    }
    return NextResponse.json(
      withPersistentCacheMeta({
        body: persisted.value,
        stale,
        refreshing: stale,
        generatedAt: persisted.generatedAt,
        expiresAt: persisted.expiresAt,
      }),
    );
  }

  const body = await buildQuantPageState();
  await persistQuantPageState(session.user.id, body).catch((error) => {
    console.warn("[QuantPageState] persist snapshot failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return NextResponse.json(body);
}
