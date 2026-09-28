import { describe, expect, it } from "vitest";
import { planCandidatePoolFlow } from "@/lib/workshops/candidate-pool-flow";
import type {
  QuantMarketCandidate,
  QuantWatchlistConfig,
  QuantWatchlistConfigItem,
} from "@/lib/quant/types";

const now = "2026-09-15T00:00:00.000Z";

function item(
  code: string,
  input: Partial<QuantWatchlistConfigItem> = {},
): QuantWatchlistConfigItem {
  return {
    code,
    name: code,
    pool: "candidate",
    status: "active",
    score: 50,
    first_seen_at: "2026-09-01T00:00:00.000Z",
    last_reviewed_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
    ...input,
  };
}

function candidate(code: string, score: number): QuantMarketCandidate {
  return {
    code,
    name: code,
    price: 10,
    change_pct: 1,
    turnover_billion: 1,
    themes: ["ai"],
    tags: [],
    score,
    scores: {
      theme_fit: score,
      liquidity: score,
      momentum: score,
      quality: score,
      risk: 50,
    },
    evidence: [{ source: "test", summary: "candidate" }],
    risks: [],
  };
}

function config(items: QuantWatchlistConfigItem[]): QuantWatchlistConfig {
  return {
    codes: [],
    items,
    source: "test",
    max_universe_symbols: 3,
    trading_enabled: false,
  };
}

describe("planCandidatePoolFlow", () => {
  it("does not let archived history consume active universe capacity", () => {
    const plan = planCandidatePoolFlow({
      config: config([
        item("000001.SZ", { score: 90 }),
        item("000002.SZ", { pool: "archived", status: "archived" }),
        item("000003.SZ", { pool: "archived", status: "archived" }),
      ]),
      discovered: [candidate("000004.SZ", 80), candidate("000005.SZ", 70)],
      theme: "ai",
      provider: "test",
      now,
    });

    expect(plan.capacity.activeAfter).toBe(3);
    expect(plan.capacity.archivedAfter).toBe(0);
    expect(plan.capacity.droppedArchivedCount).toBe(2);
    expect(plan.items.map((entry) => entry.code)).toEqual([
      "000001.SZ",
      "000004.SZ",
      "000005.SZ",
    ]);
  });

  it("archives lower priority candidates when new discoveries need room", () => {
    const plan = planCandidatePoolFlow({
      config: config([
        item("000001.SZ", { score: 95 }),
        item("000002.SZ", { score: 40 }),
        item("000003.SZ", { score: 30 }),
      ]),
      discovered: [candidate("000004.SZ", 85)],
      theme: "ai",
      provider: "test",
      now,
    });

    expect(plan.accepted.map((entry) => entry.code)).toEqual(["000004.SZ"]);
    expect(plan.archived.map((entry) => entry.code)).toEqual(["000003.SZ"]);
    expect(plan.items.map((entry) => entry.code)).toEqual([
      "000001.SZ",
      "000004.SZ",
      "000002.SZ",
    ]);
  });
});
