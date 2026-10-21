import { createHash, randomUUID } from "node:crypto";
import { resolveExecutionLease } from "@/lib/work-runtime/execution-context";
import { withRevisionStateRead, readRevisionMemoryForShare } from "../adapters/postgres/revision-state";
import { appendQueryReceipt } from "../adapters/postgres/query-receipts";
import { getBrainMemoryRevisionVersion } from "../revision/version";
import { MemoryModuleError } from "../kernel/errors";
import { stableJson } from "../records/observations";
import type { QueryVersionRef } from "../query-contracts";
import type { UnifiedMemorySearchOutput } from "../unified-search";

/** Legacy discovery keeps its response fields but never becomes an automatic
 * ContextPack. Only returned canonical rows receive fixed-version receipts;
 * auxiliary index hits remain explicitly discovery-only. */
export async function finalizeOwnerDiscovery(userId: string, result: UnifiedMemorySearchOutput) {
  if (resolveExecutionLease()) throw new MemoryModuleError("memory_owner_context_required", 403, "Owner discovery requires an owner context");
  return withRevisionStateRead(userId, async store => {
    const refs: QueryVersionRef[] = [], retained = [] as UnifiedMemorySearchOutput["results"];
    const canonicalIds = [...new Set(result.results.filter(item => item.type === "memory" && item.metadata.source === "brain_memory").map(item => item.id))].sort();
    const locked = new Map<string, Awaited<ReturnType<typeof readRevisionMemoryForShare>>>();
    for (const id of canonicalIds) locked.set(id, await readRevisionMemoryForShare(store, userId, id));
    // Capture time only after every row lock: waiting on a later row must not
    // authorize an earlier row whose natural expiry passed during that wait.
    const now = Date.now();
    let withheld = 0;
    for (const item of result.results) {
      if (item.type !== "memory" || item.metadata.source !== "brain_memory") { retained.push(item); continue; }
      const current = locked.get(item.id);
      if (!current || !["active", "verified", "weakened"].includes(current.status)
        || current.expiresAt && Date.parse(current.expiresAt) <= now
        || getBrainMemoryRevisionVersion(current) !== item.metadata.revisionVersion
        || item.content !== `${current.subject}: ${current.content}`) { withheld++; continue; }
      refs.push({ record: { kind: "memory", id: current.id }, revision: getBrainMemoryRevisionVersion(current) });
      retained.push({ ...item, metadata: { ...item.metadata, applicabilityUse: "discovery_only" } });
    }
    const warnings = [...result.warnings, ...(withheld ? [{ source: "memory" as const, code: "discovery_versions_changed",
      message: "Some discovered versions changed or expired before their receipt committed and were withheld." }] : [])];
    const receipt = await appendQueryReceipt(store, { userId, purpose: "discover", requestHash: createHash("sha256").update(stableJson({ query: result.query, sources: result.sources })).digest("hex"), refs,
      coverage: { recordKinds: ["memory"], complete: false, auxiliaryIndexes: "discovery_only_without_fixed_source_verification", canonicalRowsRevalidated: true },
      meta: { traceId: randomUUID(), contractVersion: "memory-query.v1", implementationVersion: "memory-t4.v1", provider: "postgres", detail: "compatibility_owner_discovery", warnings: [] } });
    const results = retained.map(item => item.type === "memory" && item.metadata.source === "brain_memory" ? { ...item, metadata: { ...item.metadata, readReceipt: receipt } } : item);
    return { ...result, purpose: "discover" as const, resultKind: results.length ? "legacy_discovery" as const : "empty" as const,
      contextTrace: undefined, results, count: results.length, warnings, receipt,
      sourceStatuses: result.sourceStatuses.map(source => source.source === "memory" ? { ...source, resultCount: results.filter(item => item.type === "memory").length,
        status: withheld ? "degraded" as const : source.status, warningCount: source.warningCount + (withheld ? 1 : 0) } : source) };
  });
}
