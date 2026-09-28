import { describe, expect, it } from "vitest";
import { routingMetrics } from "../../scripts/lib/jev-routing-metrics.mjs";
describe("routing quality reporting", () => {
  it("separates accepted errors from abstentions and retains abstained probabilities in bins", () => {
    const metrics = routingMetrics([
      { expectedSources: ["records"], result: { status: "ok", sources: ["architecture"], elapsedMs: 10, sourceProbabilities: { records: 0.1 } } },
      { expectedSources: ["records"], result: { status: "degraded", sources: [], elapsedMs: 20, sourceProbabilities: { records: 0.5 } } },
    ]);
    expect(metrics).toMatchObject({ acceptanceRate: 0.5, acceptedExactAccuracy: 0, degraded: 1, medianMs: 15 });
    expect(metrics.perSource.records.falseNegative).toBe(1);
    expect(metrics.perSource.architecture.falsePositive).toBe(1);
    expect(metrics.perSource.records.bins[2]).toMatchObject({ count: 1, meanProbability: 0.5, observedPositiveRate: 1 });
    expect(routingMetrics([]).acceptedExactAccuracy).toBeNull();
  });
});
