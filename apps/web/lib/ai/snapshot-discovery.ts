import { createHash } from "node:crypto";

/** Discovery is an excerpt, not a second representation of the complete record. */
export function snapshotDiscovery(snapshot: { id: string }) {
  const serialized = JSON.stringify(snapshot);
  const snapshotHash = createHash("sha256").update(serialized).digest("hex");
  return {
    id: snapshot.id,
    representation: "raw_record_excerpt" as const,
    snapshotHash,
    excerpt: serialized.slice(0, 1200),
    excerptTruncated: serialized.length > 1200,
    totalCharacters: serialized.length,
    read: { tool: "brainListSnapshots", snapshotId: snapshot.id, offset: 0, expectedHash: snapshotHash },
  };
}
