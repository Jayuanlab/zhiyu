import { createHash } from "node:crypto";
import type { GuardedPiToolDefinition } from "./runtime/pi-tool-adapter";

const readers = new Set([
  "platformRecall", "brainListSnapshots", "brainListMemories", "brainListCandidates", "brainListGrants",
  "searchUnifiedMemory", "searchMemoryPath", "searchKnowledgeBase", "listKnowledgeBaseDocuments",
  "getFullDocumentContent", "readPlatformSource", "webSearch", "webReadPage", "inspectWorkshopAgent",
  "listLoopTasks", "chatInsight", "queryContacts",
]);
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  return value;
}

/** Wrap handlers before guarded tools are created: authorization always runs first. */
export function withMemoryReadBudget(definitions: GuardedPiToolDefinition[]) {
  let reads = 0;
  let characters = 0;
  const seen = new Set<string>();
  const fail = (code: string, guidance: string): never => {
    throw Error(`${code}: ${guidance} Memory read budget: ${reads}/10 attempts, ${characters}/64000 evidence characters delivered. This is a retrieval limit, not evidence that a fact is absent.`);
  };
  return definitions.map(definition => {
    if (!readers.has(definition.name)) return definition;
    return {
      ...definition,
      description: `${definition.description} Reads share a per-instance budget: 10 attempts, 24000 characters per result, 64000 total. Only identical parameters are suppressed. A recordRead or new offset is a distinct permitted read; discovery never replaces exact expansion.`,
      execute: async (params: any, context: { toolCallId: string; signal?: AbortSignal }) => {
        context.signal?.throwIfAborted();
        const key = createHash("sha256").update(JSON.stringify([definition.name, canonical(params)])).digest("hex");
        // Catalog explicitly supports short-lived reuse/refresh; still charge each delivered result.
        const reuse = definition.name === "brainListSnapshots" && params?.view === "catalog";
        if (!reuse && seen.has(key)) fail("memory_read_not_repeated", "Reuse the previous result; the same read was already attempted or is in progress.");
        if (reads >= 10 || characters >= 64000) fail("memory_read_budget_exhausted", "Stop reading and report the remaining evidence gap.");
        reads++;
        seen.add(key);
        try {
          const result = await definition.execute(params, context);
          context.signal?.throwIfAborted();
          const text = definition.formatResult ? definition.formatResult(result)
            : typeof result === "string" ? result : result === undefined ? "" : JSON.stringify(result, null, 2);
          if (text.length > 24000 || characters + text.length > 64000) {
            fail("memory_read_output_over_budget", "The result was withheld in full. Narrow sections/limit; do not repeat the broad request. For historical run failures, first inspect platformRecall sections:[brain], limit:3 to learn source wording and exact read IDs, then expand a candidate. Literal search can miss translated/paraphrased terms; do not spend the budget guessing synonyms.");
          }
          // Commit on completion, so parallel reads cannot both spend the same remaining characters.
          characters += text.length;
          if (result && typeof result === "object" && ((result as any).ok === false || (result as any).isError === true)) seen.delete(key);
          return result;
        } catch (error) {
          // Transient source failures may be retried, but still consume attempts.
          if (!(error instanceof Error && error.message.startsWith("memory_read_output_over_budget:"))) seen.delete(key);
          throw error;
        }
      },
    };
  });
}
