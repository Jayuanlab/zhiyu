import type { ContextEntry, MemoryContextPack } from "../query-contracts";

const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
type Group = "constraints" | "currentStates" | "historicalEvidence" | "interpretations";
/** UTF-8 bytes conservatively bound token count without guessing a tokenizer.
 * Safety constraints stay complete; facts may retain only an explicit prefix. */
export function budgetContextPack(input: MemoryContextPack, reservedBytes = 0): MemoryContextPack | null {
  const questions = input.openQuestions.slice(0, 8).map(item => ({ code: item.code, detail: Array.from(item.detail).slice(0, 120).join("") }));
  const clippedQuestions = input.openQuestions.length > 8 || questions.some((item, index) => item.detail !== input.openQuestions[index].detail);
  const pack: MemoryContextPack = { ...input, constraints: [], currentStates: [], historicalEvidence: [], interpretations: [],
    openQuestions: questions,
    budget: { ...input.budget, usedUpperBound: 0, truncated: input.budget.truncated || clippedQuestions } };
  const fits = () => size(pack) + 16 + reservedBytes <= pack.budget.maxTokens;
  for (const entry of input.constraints) { pack.constraints.push(entry); if (!fits()) return null; }
  for (const group of ["currentStates", "historicalEvidence", "interpretations"] as Group[]) {
    for (const entry of input[group]) {
      pack[group].push(entry);
      if (fits()) continue;
      pack[group].pop(); pack.budget.truncated = true;
      const chars = Array.from(entry.content);
      let low = 0, high = chars.length, clipped: ContextEntry | undefined;
      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const value: ContextEntry = { ...entry, content: chars.slice(0, mid).join(""), truncated: true, truncationReason: "context_budget" };
        pack[group].push(value); const allowed = fits(); pack[group].pop();
        if (allowed) { clipped = value; low = mid + 1; } else high = mid - 1;
      }
      if (clipped?.content) pack[group].push(clipped);
    }
  }
  if (!fits()) return null;
  pack.budget.usedUpperBound = size(pack) + 16;
  return pack;
}
