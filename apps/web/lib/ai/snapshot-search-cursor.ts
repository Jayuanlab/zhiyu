import { createHash } from "node:crypto";
type Scope = { userId: string; workId?: string; query: string; recordedBefore?: string; snapshotTypes?: string[] };
type Cursor = { v: 1; queryHash: string; cutoff: string; after: { id: string; time: string } };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function fingerprint(scope: Scope) {
  return createHash("sha256").update(JSON.stringify({ userId: scope.userId, workId: scope.workId, recordedBefore: scope.recordedBefore, query: scope.query.trim(),
    snapshotTypes: scope.snapshotTypes ? [...new Set(scope.snapshotTypes)].sort() : undefined })).digest("hex");
}
export function encodeSnapshotSearchCursor(scope: Scope, cutoff: string, after: Cursor["after"]) {
  return Buffer.from(JSON.stringify({ v: 1, queryHash: fingerprint(scope), cutoff, after })).toString("base64url");
}
/** Continuation metadata, not an authorization token. Every page still applies scope filters. */
export function decodeSnapshotSearchCursor(token: string, scope: Scope): Cursor {
  if (typeof token !== "string" || token.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(token)) throw Error("Invalid snapshot search cursor");
  let value: Cursor;
  try { value = JSON.parse(Buffer.from(token, "base64url").toString("utf8")); } catch { throw Error("Invalid snapshot search cursor"); }
  if (!value || value.v !== 1 || value.queryHash !== fingerprint(scope)) throw Error("Cursor does not match this query scope; restart the search");
  if (!value.after || typeof value.after.id !== "string" || !uuid.test(value.after.id) || typeof value.after.time !== "string" || value.after.time.length > 64
    || !/^(?:\d{10,16}|\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}(?::?\d{2})?))$/.test(value.after.time)
    || typeof value.cutoff !== "string" || !Number.isFinite(Date.parse(value.cutoff))) throw Error("Invalid snapshot search cursor position");
  return value;
}
