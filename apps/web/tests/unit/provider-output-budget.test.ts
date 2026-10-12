import { describe, expect, it } from "vitest";
import { createProviderOutputBudget } from "@openzhiyu/ai/agent/runtime/provider-output-budget";

describe("same-turn upper-bound output reservations", () => {
  it("reserves main forwards and a single two-request episode without releasing unknown usage", () => {
    const budget = createProviderOutputBudget({ perRequestTokens: 2200, totalReservedTokens: 21 * 2200 });
    expect(budget.reserveMainForward()).toBe(2200);
    expect(budget.reserveContinuationEpisode()).toBe(4400);
    expect(budget.reserveContinuationEpisode()).toBeNull();
    expect(budget.snapshot()).toMatchObject({ reservedTokens: 6600, mainForwards: 1, remainingTokens: 39600 });
  });
  it("does not give an exhausted turn a fresh output budget", () => {
    const budget = createProviderOutputBudget({ perRequestTokens: 10, totalReservedTokens: 20 });
    budget.reserveMainForward(); budget.reserveMainForward();
    expect(budget.reserveContinuationEpisode()).toBeNull();
    expect(() => budget.reserveMainForward()).toThrow("budget exhausted");
    expect(budget.snapshot().reservedTokens).toBe(20);
  });
  it("atomically reserves at most the remainder and preserves the per-request maximum", () => {
    const budget = createProviderOutputBudget({ perRequestTokens: 10, totalReservedTokens: 23 });
    budget.reserveMainForward(); budget.reserveMainForward();
    expect(budget.reserveContinuationEpisode()).toBe(3);
    expect(budget.snapshot().remainingTokens).toBe(0);
  });
  it("rejects absent, fractional, negative and unsafe budget inputs", () => {
    for (const value of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) expect(() => createProviderOutputBudget({ perRequestTokens: value, totalReservedTokens: 100 })).toThrow();
    expect(() => createProviderOutputBudget({ perRequestTokens: 10, totalReservedTokens: 5 })).toThrow();
  });
});
