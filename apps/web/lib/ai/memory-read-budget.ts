import { createHash } from "node:crypto";
import { commitPlatformFieldPageDelivery, rejectPlatformFieldPageDelivery } from "./platform-field-pages";
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

export type MemoryReadBudgetSnapshot = {
  schemaVersion: "memory-read-budget.v1";
  attempts: number; reservedCharacters: number; committedCharacters: number;
  inFlight: number; inFlightSize: "unknown_until_formatted" | "none";
  maximumAttempts: 10; maximumSingleCharacters: 24000; maximumTotalCharacters: 64000;
  characterUnit: "javascript_utf16"; withheldResults: number;
  lastStopReason: "memory_read_not_repeated" | "memory_read_budget_exhausted" | "memory_read_output_over_budget" | null;
  observerFailures: number;
};
export type MemoryReadBudgetOptions = { onSnapshot?: (snapshot: MemoryReadBudgetSnapshot) => void | Promise<void> };

/** Per-instance budget shared by direct and delegated readers. No payloads enter telemetry. */
export function createMemoryReadBudget(options: MemoryReadBudgetOptions = {}) {
  let reads = 0;
  let characters = 0;
  let reservedCharacters = 0;
  let inFlight = 0;
  let withheldResults = 0;
  let observerFailures = 0;
  let lastStopReason: MemoryReadBudgetSnapshot["lastStopReason"] = null;
  const seen = new Set<string>();
  const snapshot = (): MemoryReadBudgetSnapshot => ({ schemaVersion: "memory-read-budget.v1", attempts: reads,
    reservedCharacters, committedCharacters: characters, inFlight, inFlightSize: inFlight ? "unknown_until_formatted" : "none",
    maximumAttempts: 10, maximumSingleCharacters: 24000, maximumTotalCharacters: 64000,
    characterUnit: "javascript_utf16", withheldResults, lastStopReason, observerFailures });
  const emit = () => {
    try {
      const pending = options.onSnapshot?.(snapshot());
      if (pending) void Promise.resolve(pending).catch(() => { observerFailures++; });
    } catch { observerFailures++; }
  };
  const fail = (code: NonNullable<MemoryReadBudgetSnapshot["lastStopReason"]>, guidance: string): never => {
    lastStopReason = code;
    emit();
    throw Error(`${code}: ${guidance} Memory read budget: ${reads}/10 attempts, ${characters}/64000 evidence characters delivered. This is a retrieval limit, not evidence that a fact is absent.`);
  };
  const wrap = (definitions: GuardedPiToolDefinition[]) => definitions.map(definition => {
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
        reads++; inFlight++;
        seen.add(key);
        emit();
        let constructedResult: unknown;
        try {
          const result = await definition.execute(params, context);
          constructedResult = result;
          context.signal?.throwIfAborted();
          const text = definition.formatResult ? definition.formatResult(result)
            : typeof result === "string" ? result : result === undefined ? "" : JSON.stringify(result, null, 2);
          if (text.length > 24000 || characters + text.length > 64000) {
            rejectPlatformFieldPageDelivery(result);
            withheldResults++;
            fail("memory_read_output_over_budget", "The result was withheld in full. Narrow sections/limit; do not repeat the broad request. For historical run failures, first inspect platformRecall sections:[brain], limit:3 to learn source wording and exact read IDs, then expand a candidate. Literal search can miss translated/paraphrased terms; do not spend the budget guessing synonyms.");
          }
          // Commit on completion, so parallel reads cannot both spend the same remaining characters.
          reservedCharacters += text.length;
          emit();
          characters += text.length;
          reservedCharacters -= text.length;
          commitPlatformFieldPageDelivery(result);
          if (result && typeof result === "object" && ((result as any).ok === false || (result as any).isError === true)) seen.delete(key);
          return result;
        } catch (error) {
          rejectPlatformFieldPageDelivery(constructedResult);
          // Transient source failures may be retried, but still consume attempts.
          if (!(error instanceof Error && error.message.startsWith("memory_read_output_over_budget:"))) seen.delete(key);
          throw error;
        } finally {
          inFlight--;
          emit();
        }
      },
    };
  });
  return { wrap, snapshot };
}

/** Wrap handlers before guarded tools are created: authorization always runs first. */
export function withMemoryReadBudget(definitions: GuardedPiToolDefinition[], options?: MemoryReadBudgetOptions) {
  return createMemoryReadBudget(options).wrap(definitions);
}
