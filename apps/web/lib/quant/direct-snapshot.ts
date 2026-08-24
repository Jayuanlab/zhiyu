import "server-only";

import {
  readPageStateSnapshot,
  writePageStateSnapshot,
} from "@/lib/page-state/snapshots";
import type { QuantDashboard, QuantPageState, QuantPaperAccount } from "./types";

export const QUANT_PAGE_STATE_SNAPSHOT_KEY = "quant:index";
export const QUANT_DASHBOARD_SNAPSHOT_KEY = "quant:dashboard";
export const QUANT_PAPER_ACCOUNT_SNAPSHOT_KEY = "quant:paper:account";

const DIRECT_TTL_MS = 10_000;
const DIRECT_STALE_TTL_MS = 30 * 60_000;

export type QuantDirectSnapshotMeta = {
  hit: boolean;
  stale: boolean;
  refreshing: boolean;
  fetched_at: string;
  expires_at: string;
  warning?: string;
};

function directTtlMs() {
  const configured = Number(process.env.QUANT_DIRECT_SNAPSHOT_TTL_MS);
  return Number.isFinite(configured) && configured >= 0
    ? configured
    : DIRECT_TTL_MS;
}

function directStaleTtlMs() {
  const configured = Number(process.env.QUANT_DIRECT_SNAPSHOT_STALE_TTL_MS);
  return Number.isFinite(configured) && configured >= 0
    ? configured
    : DIRECT_STALE_TTL_MS;
}

function withDirectSnapshotMeta<T extends Record<string, unknown>>(
  value: T,
  meta: QuantDirectSnapshotMeta,
): T {
  const existing =
    value.cache && typeof value.cache === "object" && !Array.isArray(value.cache)
      ? (value.cache as Record<string, unknown>)
      : {};
  return {
    ...value,
    cache: {
      ...existing,
      ...meta,
    },
  };
}

async function persistQuantDirectSnapshot<T extends Record<string, unknown>>(
  input: {
    userId: string;
    key: string;
    value: T;
  },
) {
  const generatedAt = new Date();
  const expiresAt = new Date(generatedAt.getTime() + directTtlMs());
  const staleUntil = new Date(expiresAt.getTime() + directStaleTtlMs());
  await writePageStateSnapshot({
    userId: input.userId,
    key: input.key,
    value: input.value,
    meta: {
      source: "quant-direct-snapshot",
      generatedAt: generatedAt.toISOString(),
    },
    generatedAt,
    expiresAt,
    staleUntil,
  });
}

export async function persistQuantDashboardSnapshot(input: {
  userId: string;
  dashboard: QuantDashboard;
}) {
  await persistQuantDirectSnapshot({
    userId: input.userId,
    key: QUANT_DASHBOARD_SNAPSHOT_KEY,
    value: input.dashboard as unknown as Record<string, unknown>,
  });
}

export async function persistQuantPaperAccountSnapshot(input: {
  userId: string;
  account: QuantPaperAccount;
}) {
  await persistQuantDirectSnapshot({
    userId: input.userId,
    key: QUANT_PAPER_ACCOUNT_SNAPSHOT_KEY,
    value: input.account as unknown as Record<string, unknown>,
  });
}

async function readDirectSnapshot<T extends Record<string, unknown>>(input: {
  userId: string;
  key: string;
  warning: string;
}): Promise<T | null> {
  const snapshot = await readPageStateSnapshot<T>({
    userId: input.userId,
    key: input.key,
  }).catch(() => null);
  if (!snapshot || snapshot.staleUntil.getTime() < Date.now()) return null;

  return withDirectSnapshotMeta(snapshot.value, {
    hit: true,
    stale: snapshot.expiresAt.getTime() < Date.now(),
    refreshing: true,
    fetched_at: snapshot.generatedAt.toISOString(),
    expires_at: snapshot.expiresAt.toISOString(),
    warning: input.warning,
  });
}

async function readQuantPageStateSnapshot<T extends Record<string, unknown>>(input: {
  userId: string;
  pick: (pageState: QuantPageState) => T | null;
  warning: string;
}): Promise<T | null> {
  const snapshot = await readPageStateSnapshot<QuantPageState>({
    userId: input.userId,
    key: QUANT_PAGE_STATE_SNAPSHOT_KEY,
  }).catch(() => null);
  if (!snapshot || snapshot.staleUntil.getTime() < Date.now()) return null;

  const value = input.pick(snapshot.value);
  if (!value) return null;

  return withDirectSnapshotMeta(value, {
    hit: true,
    stale: true,
    refreshing: true,
    fetched_at: snapshot.generatedAt.toISOString(),
    expires_at: snapshot.expiresAt.toISOString(),
    warning: input.warning,
  });
}

export async function readPersistedQuantDashboard(input: {
  userId: string;
  warning: string;
}): Promise<QuantDashboard | null> {
  return (
    ((await readDirectSnapshot({
      userId: input.userId,
      key: QUANT_DASHBOARD_SNAPSHOT_KEY,
      warning: input.warning,
    })) as QuantDashboard | null) ??
    ((await readQuantPageStateSnapshot({
      userId: input.userId,
      warning: input.warning,
      pick: (pageState) =>
        pageState.dashboard as unknown as Record<string, unknown> | null,
    })) as QuantDashboard | null)
  );
}

export async function readPersistedQuantPaperAccount(input: {
  userId: string;
  warning: string;
}): Promise<QuantPaperAccount | null> {
  return (
    ((await readDirectSnapshot({
      userId: input.userId,
      key: QUANT_PAPER_ACCOUNT_SNAPSHOT_KEY,
      warning: input.warning,
    })) as QuantPaperAccount | null) ??
    ((await readQuantPageStateSnapshot({
      userId: input.userId,
      warning: input.warning,
      pick: (pageState) =>
        pageState.account as unknown as Record<string, unknown> | null,
    })) as QuantPaperAccount | null)
  );
}
