import type { BrainMemoryFacets } from "./memory-canonical";
import type { BrainSourceFilters } from "./memory-types";

function normalizedList(values: string[] | undefined) {
  return new Set(
    (values ?? [])
      .map((value) => value.trim().toLowerCase().normalize("NFKC"))
      .filter(Boolean),
  );
}

function facetValues(
  facets: BrainMemoryFacets,
  key: "sourceKind" | "privacyClass" | "riskLevel" | "scenarioKeys",
) {
  const value = facets[key];
  if (Array.isArray(value)) {
    return value
      .map((item) => item.trim().toLowerCase().normalize("NFKC"))
      .filter(Boolean);
  }
  if (typeof value === "string" && value.trim()) {
    return [value.trim().toLowerCase().normalize("NFKC")];
  }
  return [];
}

function intersects(required: Set<string>, values: string[]) {
  if (required.size === 0) return true;
  return values.some((value) => required.has(value));
}

export function sourceFilterOmitReason(
  facets: BrainMemoryFacets,
  filters: BrainSourceFilters | undefined,
) {
  if (!filters) return null;
  const sourceKinds = normalizedList(filters.sourceKinds);
  if (
    sourceKinds.size > 0 &&
    !intersects(sourceKinds, facetValues(facets, "sourceKind"))
  ) {
    return "source_filter:source_kind";
  }
  const privacyClasses = normalizedList(filters.privacyClasses);
  if (
    privacyClasses.size > 0 &&
    !intersects(privacyClasses, facetValues(facets, "privacyClass"))
  ) {
    return "source_filter:privacy_class";
  }
  const excludedPrivacyClasses = normalizedList(filters.excludePrivacyClasses);
  if (
    excludedPrivacyClasses.size > 0 &&
    intersects(excludedPrivacyClasses, facetValues(facets, "privacyClass"))
  ) {
    return "source_filter:privacy_class_excluded";
  }
  const riskLevels = normalizedList(filters.riskLevels);
  if (
    riskLevels.size > 0 &&
    !intersects(riskLevels, facetValues(facets, "riskLevel"))
  ) {
    return "source_filter:risk_level";
  }
  return null;
}
