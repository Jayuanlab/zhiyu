/** Reservations are upper bounds, not measured usage or provider billing. */
export function createProviderOutputBudget(input: { perRequestTokens: number; totalReservedTokens: number }) {
  if (!Number.isSafeInteger(input.perRequestTokens) || input.perRequestTokens < 1
    || !Number.isSafeInteger(input.totalReservedTokens) || input.totalReservedTokens < input.perRequestTokens) throw Error("Invalid provider output reservation budget");
  let reservedTokens = 0;
  let mainForwards = 0;
  let continuationGrant: number | null = null;
  return {
    reserveMainForward() {
      if (reservedTokens + input.perRequestTokens > input.totalReservedTokens) throw Error("Provider output reservation budget exhausted");
      reservedTokens += input.perRequestTokens; mainForwards++;
      return input.perRequestTokens;
    },
    /** One atomic grant from this same turn's unused capacity; never reset it. */
    reserveContinuationEpisode() {
      if (continuationGrant !== null) return null;
      const remaining = input.totalReservedTokens - reservedTokens;
      if (remaining < 2) return null;
      continuationGrant = Math.min(2 * input.perRequestTokens, remaining);
      reservedTokens += continuationGrant;
      return continuationGrant;
    },
    snapshot() { return { schemaVersion: "provider-output-reservations.v1" as const, measurement: "configured_upper_bound_reservations" as const,
      perRequestTokens: input.perRequestTokens, totalReservedTokens: input.totalReservedTokens, reservedTokens,
      remainingTokens: input.totalReservedTokens - reservedTokens, mainForwards, continuationGrant }; },
  };
}
