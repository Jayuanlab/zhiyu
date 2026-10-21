import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { memoryArtifactManifests } from "@/lib/db/schema.pg";
import { artifactPublicManifest, artifactRef, persistArtifactRead, withArtifactOwner } from "../adapters/postgres/artifacts";
import { memoryInvalid } from "../kernel/errors";
import { stableJson } from "../records/observations";
import type { ArtifactState } from "./contracts";

const states: ArtifactState[] = ["pending", "sealed", "active", "deleting", "deleted"];
/** Includes unsaved attachments and unfinished uploads so occupied space and
 * recovery work never disappear behind the saved-file business list. */
export async function inspectOwnerArtifacts(userId: string, input: unknown = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) memoryInvalid("Invalid artifact list query");
  const query = input as Record<string, unknown>;
  if (Object.keys(query).some(key => !["limit", "cursor", "states"].includes(key))) memoryInvalid("Unexpected artifact list field");
  const limit = query.limit === undefined ? 20 : Number(query.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) memoryInvalid("Invalid artifact list limit");
  const selected = query.states === undefined ? states.filter(state => state !== "deleted") : query.states;
  if (!Array.isArray(selected) || !selected.length || selected.length > states.length || selected.some(state => !states.includes(state))) memoryInvalid("Invalid artifact list state");
  const signature = createHash("sha256").update(stableJson({ userId, limit, states: [...selected].sort() })).digest("hex");
  let cursor: { time: string; id: string } | undefined;
  if (query.cursor !== undefined) {
    try {
      if (typeof query.cursor !== "string" || query.cursor.length > 2048) memoryInvalid("Invalid artifact cursor");
      const value = JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8"));
      if (value.signature !== signature || typeof value.time !== "string" || value.time.length > 80 || !Number.isFinite(Date.parse(value.time))
        || typeof value.id !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value.id)) memoryInvalid("Invalid artifact cursor");
      cursor = { time: value.time, id: value.id };
    } catch { memoryInvalid("Invalid artifact cursor"); }
  }
  return withArtifactOwner(userId, "share", async store => {
    const rows = await store.select({ row: memoryArtifactManifests, pageTime: sql<string>`cast(${memoryArtifactManifests.createdAt} as text)` })
      .from(memoryArtifactManifests).where(and(eq(memoryArtifactManifests.userId, userId), inArray(memoryArtifactManifests.state, selected as ArtifactState[]),
        cursor ? sql`(${memoryArtifactManifests.createdAt}, ${memoryArtifactManifests.id}) < (${cursor.time}::timestamptz, ${cursor.id}::uuid)` : undefined))
      .orderBy(desc(memoryArtifactManifests.createdAt), desc(memoryArtifactManifests.id)).limit(limit + 1).for("share");
    const page = rows.slice(0, limit), items = [];
    for (const { row } of page) items.push({ manifest: artifactPublicManifest(row), ref: artifactRef(row),
      receipt: await persistArtifactRead(store, row, { start: 0, end: 0 }, "current") });
    const last = page.at(-1);
    return { status: items.length ? "observed" as const : "unobserved" as const, items,
      nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify({ signature, time: last.pageTime, id: last.row.id })).toString("base64url") : null,
      coverage: { bounded: true, complete: false, limit, bodyIncluded: false, scope: "registered_private_artifacts_only" },
      warnings: ["清单只证明已登记文件的状态；原文读取仍需 active 清单、当前权限、完整性校验与实际窗口回执。"] };
  });
}
