import type {
  QuantDashboard,
  QuantMarketCandidatesResponse,
} from "@/lib/quant/types";

function lowerText(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function includesUnavailableSource(value: string): boolean {
  return (
    value.includes("sample") ||
    value.includes("mock") ||
    value.includes("default") ||
    value.includes("unavailable")
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function hasUsableCandidateRows(
  candidates: QuantMarketCandidatesResponse,
): boolean {
  if (candidates.items.length === 0) return false;

  return candidates.items.every((item) => {
    return (
      typeof item.code === "string" &&
      item.code.trim().length > 0 &&
      typeof item.name === "string" &&
      item.name.trim().length > 0 &&
      isFiniteNumber(item.price) &&
      item.price > 0 &&
      isFiniteNumber(item.change_pct) &&
      isFiniteNumber(item.turnover_billion) &&
      item.turnover_billion >= 0 &&
      isFiniteNumber(item.score) &&
      item.scores &&
      isFiniteNumber(item.scores.theme_fit) &&
      isFiniteNumber(item.scores.liquidity) &&
      isFiniteNumber(item.scores.momentum) &&
      isFiniteNumber(item.scores.quality) &&
      isFiniteNumber(item.scores.risk) &&
      Array.isArray(item.evidence) &&
      item.evidence.length > 0
    );
  });
}

export function assertQuantDashboardUsableForControl(
  dashboard: QuantDashboard,
  controlName = "Quant control",
) {
  if (dashboard.service_mode !== "live") {
    const detail =
      dashboard.provider_error ??
      dashboard.data_source_detail ??
      dashboard.watchlist_source ??
      "live quant observations unavailable";
    throw new Error(
      `${controlName} blocked: quant dashboard is not live (${detail}).`,
    );
  }
  if (dashboard.watchlist_source === "configured_unavailable") {
    throw new Error(
      `${controlName} blocked: configured watchlist quotes are unavailable.`,
    );
  }
}

export function assertQuantCandidatesUsableForControl(
  candidates: QuantMarketCandidatesResponse,
  controlName = "Candidate pool persistence",
) {
  const provider = lowerText(candidates.provider);
  const detail = lowerText(candidates.data_source_detail);
  const conceptSourceText = (candidates.concept_sources ?? [])
    .map((source) => Object.values(source).map(lowerText).join(" "))
    .join(" ");

  if (
    includesUnavailableSource(provider) ||
    includesUnavailableSource(detail) ||
    includesUnavailableSource(conceptSourceText)
  ) {
    const sourceDetail =
      candidates.data_source_detail ??
      candidates.provider ??
      "unavailable market candidate source";
    throw new Error(
      `${controlName} blocked: market candidates were produced from unavailable or sample data (${sourceDetail}).`,
    );
  }

  if (!hasUsableCandidateRows(candidates)) {
    const sourceDetail =
      candidates.data_source_detail ?? candidates.provider ?? "unknown source";
    throw new Error(
      `${controlName} blocked: market candidates are incomplete (${sourceDetail}).`,
    );
  }
}
