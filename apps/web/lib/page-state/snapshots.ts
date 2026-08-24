import "server-only";

import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { pageStateSnapshots } from "@/lib/db/schema";

export type PageStateSnapshotRecord<TValue = Record<string, unknown>> = {
  userId: string;
  key: string;
  value: TValue;
  meta: Record<string, unknown>;
  generatedAt: Date;
  expiresAt: Date;
  staleUntil: Date;
};

function toJsonStorage(value: Record<string, unknown>) {
  return process.env.USE_SQLITE_DATABASE === "true"
    ? JSON.stringify(value)
    : value;
}

function fromJsonStorage(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export async function readPageStateSnapshot<TValue = Record<string, unknown>>(
  input: {
    userId: string;
    key: string;
  },
): Promise<PageStateSnapshotRecord<TValue> | null> {
  const [row] = await db
    .select()
    .from(pageStateSnapshots)
    .where(
      and(
        eq(pageStateSnapshots.userId, input.userId),
        eq(pageStateSnapshots.key, input.key),
      ),
    )
    .limit(1);

  if (!row) return null;

  return {
    userId: row.userId,
    key: row.key,
    value: fromJsonStorage(row.value) as TValue,
    meta: fromJsonStorage(row.meta),
    generatedAt: row.generatedAt,
    expiresAt: row.expiresAt,
    staleUntil: row.staleUntil,
  };
}

export async function writePageStateSnapshot<TValue extends Record<string, unknown>>(
  input: PageStateSnapshotRecord<TValue>,
) {
  const now = new Date();
  const row = {
    userId: input.userId,
    key: input.key,
    value: toJsonStorage(input.value),
    meta: toJsonStorage(input.meta),
    generatedAt: input.generatedAt,
    expiresAt: input.expiresAt,
    staleUntil: input.staleUntil,
    updatedAt: now,
  };

  await db
    .insert(pageStateSnapshots)
    .values({
      id: crypto.randomUUID(),
      ...row,
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: [pageStateSnapshots.userId, pageStateSnapshots.key],
      set: row,
    });
}
