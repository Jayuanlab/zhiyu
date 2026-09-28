import type { listBrainSnapshotsForUser } from "./brain-read-tools";

type Input = Parameters<typeof listBrainSnapshotsForUser>[0];
type Result = Awaited<ReturnType<typeof listBrainSnapshotsForUser>>;

/** Instance-local catalog reuse. Invoke only inside the permission-checked handler. */
export function createSnapshotCatalogReader(read: (input: Input) => Promise<Result>, now = Date.now) {
  const entries = new Map<string, { result: Result; readAt: number }>();
  return async (input: Input & { refresh?: boolean }): Promise<Result> => {
    const { refresh, ...query } = input;
    // Exact/versioned reads and record payloads always reach the source.
    if (query.view !== "catalog" || query.snapshotId || query.offset !== undefined || query.expectedHash !== undefined || query.contentQuery !== undefined || query.cursor !== undefined) return read(query);
    const key = JSON.stringify({ userId: query.userId, workId: query.workId, recordedBefore: query.recordedBefore,
      snapshotTypes: Array.isArray(query.snapshotTypes) ? [...query.snapshotTypes].sort() : query.snapshotTypes });
    const cached = entries.get(key);
    const age = cached ? now() - cached.readAt : Infinity;
    if (!refresh && cached && age >= 0 && age < 30000) {
      const result = structuredClone(cached.result);
      const data = { ...result.data, readReuse: { reused: true, ageMs: age, sourceReadAt: new Date(cached.readAt).toISOString(),
        warning: "This is the earlier catalog observation, not a new database read. Use its evidence, narrow the query or read an exact snapshot. Use refresh:true only when a fresh observation is required." } };
      return { ...result, data, text: JSON.stringify(data) };
    }
    // Failed refreshes must not silently fall back to old evidence.
    entries.delete(key);
    const result = await read(query);
    if (result.ok && !result.isError && result.data && result.text.length <= 64000) {
      if (entries.size >= 8) entries.delete(entries.keys().next().value!);
      entries.set(key, { result: structuredClone(result), readAt: now() });
    }
    return result;
  };
}
