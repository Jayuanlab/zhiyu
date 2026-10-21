export type BrainCanonicalStorageStatus = {
  checkedAt: string;
  migrationReady: boolean;
  status: "ok" | "degraded" | "migration_missing";
  totalMemories: number;
  canonicalKindRows: number;
  canonicalGroupRows: number;
  canonicalKindCoverage: number;
  canonicalGroupCoverage: number;
  sampleQueryMs: number | null;
  warnings: string[];
  error: string | null;
};
