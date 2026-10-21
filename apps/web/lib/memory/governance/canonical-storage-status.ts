import { readCanonicalStorageCounts, sampleCanonicalStorageMemory } from "../adapters/postgres/canonical-storage";
import type { BrainCanonicalStorageStatus } from "../records/canonical-storage";
export type { BrainCanonicalStorageStatus } from "../records/canonical-storage";
function ratio(numerator: number, denominator: number) { return denominator > 0 ? numerator / denominator : 1; }
export async function getBrainCanonicalStorageStatus(input: {
  userId: string;
}): Promise<BrainCanonicalStorageStatus> {
  const checkedAt = new Date().toISOString();
  try {
    const summary = await readCanonicalStorageCounts(input.userId);
    const sampleStartedAt = Date.now();
    await sampleCanonicalStorageMemory(input.userId);
    const sampleQueryMs = Date.now() - sampleStartedAt;
    const totalMemories = Number(summary?.totalMemories ?? 0);
    const canonicalKindRows = Number(summary?.canonicalKindRows ?? 0);
    const canonicalGroupRows = Number(summary?.canonicalGroupRows ?? 0);
    const canonicalKindCoverage = ratio(canonicalKindRows, totalMemories);
    const canonicalGroupCoverage = ratio(canonicalGroupRows, totalMemories);
    const warnings: string[] = [];
    if (totalMemories > 0 && canonicalKindCoverage < 0.95) {
      warnings.push("canonical_kind coverage is below 95%; backfill may still be incomplete.");
    }
    if (totalMemories > 0 && canonicalGroupCoverage < 0.95) {
      warnings.push("canonical_group_id coverage is below 95%; dedupe prefilter may be incomplete.");
    }
    if (sampleQueryMs > 250) {
      warnings.push("canonicalKind sample query is slower than 250ms; inspect index usage.");
    }
    return {
      checkedAt,
      migrationReady: true,
      status: warnings.length > 0 ? "degraded" : "ok",
      totalMemories,
      canonicalKindRows,
      canonicalGroupRows,
      canonicalKindCoverage,
      canonicalGroupCoverage,
      sampleQueryMs,
      warnings,
      error: null,
    };
  } catch (error) {
    return {
      checkedAt,
      migrationReady: false,
      status: "migration_missing",
      totalMemories: 0,
      canonicalKindRows: 0,
      canonicalGroupRows: 0,
      canonicalKindCoverage: 0,
      canonicalGroupCoverage: 0,
      sampleQueryMs: null,
      warnings: [
        "Brain canonical storage columns or indexes are not queryable; run the canonical memory migration before production rollout.",
      ],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
