import type {
  QuantMarketCandidate,
  QuantWatchlistConfig,
  QuantWatchlistConfigItem,
} from "@/lib/quant/types";
import { normalizeQuantWatchlistCode } from "./quant-watchlist-proposal-service";

export type CandidatePoolFlowPlan = {
  items: QuantWatchlistConfigItem[];
  accepted: QuantWatchlistConfigItem[];
  archived: QuantWatchlistConfigItem[];
  skipped: Array<{ code: string; reason: string }>;
  capacity: {
    maxUniverse: number;
    activeBefore: number;
    activeAfter: number;
    archivedAfter: number;
    droppedArchivedCount: number;
    freeSlotsAfter: number;
  };
};

type PlanCandidatePoolFlowInput = {
  config: QuantWatchlistConfig;
  discovered: QuantMarketCandidate[];
  theme: string;
  provider: string;
  now: string;
};

const DEFAULT_MAX_UNIVERSE = 100;

function normalizedItemCode(item: Pick<QuantWatchlistConfigItem, "code">) {
  return normalizeQuantWatchlistCode(item.code) ?? item.code;
}

function isArchivedItem(item: QuantWatchlistConfigItem) {
  return item.pool === "archived" || item.status === "archived";
}

function candidateScore(item: QuantWatchlistConfigItem) {
  return typeof item.score === "number" && Number.isFinite(item.score)
    ? item.score
    : 0;
}

function itemTime(item: QuantWatchlistConfigItem) {
  const raw = item.last_reviewed_at ?? item.updated_at ?? item.first_seen_at;
  if (!raw) return 0;
  const time = new Date(raw).getTime();
  return Number.isFinite(time) ? time : 0;
}

function candidatePriority(item: QuantWatchlistConfigItem) {
  return candidateScore(item) * 1_000_000_000_000 + itemTime(item);
}

function archiveDisplacedCandidate(
  item: QuantWatchlistConfigItem,
  now: string,
): QuantWatchlistConfigItem {
  return {
    ...item,
    pool: "archived",
    status: "archived",
    reason: item.reason
      ? `${item.reason}; displaced_by_candidate_pool_flow`
      : "displaced_by_candidate_pool_flow",
    last_reviewed_at: now,
    updated_at: now,
    evidence: [
      ...(Array.isArray(item.evidence) ? item.evidence : []),
      {
        source: "candidatePoolFlow",
        summary: "Archived to keep the active candidate universe within capacity.",
        action: "archive",
        archived_at: now,
      },
    ],
  };
}

function candidateToItem(input: {
  candidate: QuantMarketCandidate;
  theme: string;
  provider: string;
  now: string;
}): QuantWatchlistConfigItem {
  return {
    code: input.candidate.code,
    name: input.candidate.name,
    pool: "candidate",
    status: "active",
    source: "watchlist_hunter",
    reason: `Candidate discovered for theme: ${input.theme || "broad market"}`,
    evidence: input.candidate.evidence.map((evidence) => ({ ...evidence })),
    score: input.candidate.score,
    confidence: Math.round(Math.max(0, Math.min(100, input.candidate.score))),
    data_quality: input.provider,
    first_seen_at: input.now,
    last_reviewed_at: input.now,
    updated_at: input.now,
  };
}

export function planCandidatePoolFlow(
  input: PlanCandidatePoolFlowInput,
): CandidatePoolFlowPlan {
  const maxUniverse =
    input.config.max_universe_symbols && input.config.max_universe_symbols > 0
      ? input.config.max_universe_symbols
      : DEFAULT_MAX_UNIVERSE;
  const existingItems = input.config.items ?? [];
  const activeBefore = existingItems.filter((item) => !isArchivedItem(item)).length;
  const protectedCodes = new Set(
    input.config.codes
      .map((code) => normalizeQuantWatchlistCode(code))
      .filter((code): code is string => Boolean(code)),
  );
  const activeByCode = new Map<string, QuantWatchlistConfigItem>();
  const archivedByCode = new Map<string, QuantWatchlistConfigItem>();

  for (const item of existingItems) {
    const code = normalizedItemCode(item);
    if (isArchivedItem(item)) archivedByCode.set(code, item);
    else activeByCode.set(code, item);
  }

  const accepted: QuantWatchlistConfigItem[] = [];
  const skipped: Array<{ code: string; reason: string }> = [];
  for (const candidate of input.discovered) {
    const code = normalizeQuantWatchlistCode(candidate.code);
    if (!code) {
      skipped.push({ code: candidate.code, reason: "invalid_code" });
      continue;
    }
    if (activeByCode.has(code)) {
      const current = activeByCode.get(code)!;
      activeByCode.set(code, {
        ...current,
        name: current.name ?? candidate.name,
        score:
          typeof current.score === "number"
            ? Math.max(current.score, candidate.score)
            : candidate.score,
        confidence: Math.max(
          typeof current.confidence === "number" ? current.confidence : 0,
          Math.round(Math.max(0, Math.min(100, candidate.score))),
        ),
        last_reviewed_at: input.now,
        updated_at: input.now,
      });
      skipped.push({ code, reason: "already_active" });
      continue;
    }
    const item = candidateToItem({
      candidate: { ...candidate, code },
      theme: input.theme,
      provider: input.provider,
      now: input.now,
    });
    activeByCode.set(code, item);
    archivedByCode.delete(code);
    accepted.push(item);
  }

  const protectedActive = [...activeByCode.values()].filter((item) =>
    protectedCodes.has(normalizedItemCode(item)),
  );
  const floatingActive = [...activeByCode.values()].filter(
    (item) => !protectedCodes.has(normalizedItemCode(item)),
  );
  floatingActive.sort((left, right) => candidatePriority(right) - candidatePriority(left));

  const activeSlots = Math.max(0, maxUniverse - protectedActive.length);
  const keptFloating = floatingActive.slice(0, activeSlots);
  const displaced = floatingActive.slice(activeSlots);
  const archived = displaced
    .filter((item) => item.pool === "candidate")
    .map((item) => archiveDisplacedCandidate(item, input.now));
  for (const item of archived) archivedByCode.set(normalizedItemCode(item), item);

  const activeItems = [...protectedActive, ...keptFloating];
  const archivedItems = [...archivedByCode.values()].sort(
    (left, right) => itemTime(right) - itemTime(left),
  );
  const archivedSlots = Math.max(0, maxUniverse - activeItems.length);
  const persistedArchivedItems = archivedItems.slice(0, archivedSlots);

  return {
    items: [...activeItems, ...persistedArchivedItems],
    accepted: accepted.filter((item) =>
      activeItems.some((active) => normalizedItemCode(active) === normalizedItemCode(item)),
    ),
    archived,
    skipped,
    capacity: {
      maxUniverse,
      activeBefore,
      activeAfter: activeItems.length,
      archivedAfter: persistedArchivedItems.length,
      droppedArchivedCount: Math.max(
        0,
        archivedItems.length - persistedArchivedItems.length,
      ),
      freeSlotsAfter: Math.max(0, maxUniverse - activeItems.length),
    },
  };
}
