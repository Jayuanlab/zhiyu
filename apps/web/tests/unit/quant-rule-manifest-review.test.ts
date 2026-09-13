import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { reviewWorkshopManifest } from "@/lib/workshops/manifest";

describe("quant rule manifest integration", () => {
  for (const name of [
    "paper-trader.workshop.yaml",
    "watchlist-hunter.workshop.yaml",
    "ai-etf-timing-advisor.workshop.yaml",
  ]) {
    it(`${name} passes review and requests quantRuleEvaluate`, async () => {
      const manifestYaml = readFileSync(
        join(process.cwd(), "..", "..", "manifests", "workshops", name),
        "utf8",
      );

      const { review } = await reviewWorkshopManifest({
        manifestYaml,
        userId: "00000000-0000-0000-0000-000000000000",
        existingWorkshops: [],
      });

      expect(review.issues.filter((issue) => issue.severity === "error")).toEqual(
        [],
      );
      expect(review.requestedTools).toContain("quantRuleEvaluate");
    });
  }

  it("ai-etf-timing-advisor keeps all-in/all-out advice-only boundaries", async () => {
    const manifestYaml = readFileSync(
      join(
        process.cwd(),
        "..",
        "..",
        "manifests",
        "workshops",
        "ai-etf-timing-advisor.workshop.yaml",
      ),
      "utf8",
    );

    const { review } = await reviewWorkshopManifest({
      manifestYaml,
      userId: "00000000-0000-0000-0000-000000000000",
      existingWorkshops: [],
    });

    expect(review.issues.filter((issue) => issue.severity === "error")).toEqual(
      [],
    );
    expect(review.requestedSkills).toContain("single-etf-timing-advisor");
    expect(review.requestedTools).toEqual(
      expect.arrayContaining([
        "aStockQuote",
        "aStockTrendSystem",
        "aStockMarketMood",
        "aStockNewsAndFilings",
        "aStockEtfHoldings",
        "aStockFundamentals",
        "quantTradePlanList",
        "quantTradePlanUpsert",
        "webReadPage",
      ]),
    );
    expect(review.requestedTools).not.toContain("quantPaperPlaceOrder");
    expect(review.requestedTools).not.toContain("quantPaperCancelOrder");
    expect(review.requestedTools).not.toContain("realBrokerOrder");
    expect(review.deniedTools).toEqual(
      expect.arrayContaining([
        "quantPaperPlaceOrder",
        "quantPaperCancelOrder",
        "realBrokerOrder",
        "quantMarketDiscoverCandidates",
        "quantPaperProposeWatchlistChange",
      ]),
    );
  });
});
