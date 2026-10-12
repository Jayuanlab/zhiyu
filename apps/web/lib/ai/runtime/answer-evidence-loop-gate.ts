import { createHash } from "node:crypto";
import type { AgentMessage, AgentRuntimeTerminal } from "@openzhiyu/ai/agent/types";
import { MAX_ANSWER_DRAFT_CHARACTERS, type AnswerEvidenceSession } from "./answer-evidence-session";
import type { AnswerDecision, FinalizeAnswerInput } from "./answer-evidence-contract";
import type { PlatformAnswerDecision } from "./platform-answer-contract";

type GateDecision = AnswerDecision | PlatformAnswerDecision;
type GateSession = {
  mode: string; supported: boolean; turnId: string;
  observeToolResult(event: AgentMessage): Promise<void>;
  finalize(input: FinalizeAnswerInput): Promise<GateDecision>;
};

/** Route matching selects a bounded contract; it never scores arbitrary prose. */
export function guardExactLoopAnswer(
  source: AsyncGenerator<AgentMessage>, session: AnswerEvidenceSession,
): AsyncGenerator<AgentMessage> {
  return guardEvidenceAnswerStream(source, session, "enforce_critical", decision => ({
    schemaVersion: "answer-evidence-summary.v1", mode: session.mode, turnId: session.turnId,
    ruleVersion: decision.ruleVersion, outcome: decision.outcome, displayText: decision.renderedText,
    resolutions: decision.resolutions, evidenceRefs: decision.evidenceRefs,
    renderedTextHash: decision.renderedTextHash, auditPersisted: decision.auditPersisted, auditIncomplete: decision.auditIncomplete,
  }));
}

/** Shared stream finalization; domain wrappers select only summary/version and mode. */
export async function* guardEvidenceAnswerStream(
  source: AsyncGenerator<AgentMessage>, session: GateSession, enforceMode: string,
  summary: (decision: GateDecision) => Record<string, unknown>,
): AsyncGenerator<AgentMessage> {
  if (session.mode === "off" || !session.supported) { yield* source; return; }
  let rawDraft = "", characters = 0, overflow = false, streamedSegment = false;
  let terminal: AgentRuntimeTerminal | null = null;
  let failed = false;
  let done: AgentMessage | undefined;
  let finalized = false;
  let draftHash: string | undefined;
  const hash = createHash("sha256");
  const add = (chunk: string) => {
    hash.update(chunk); characters += chunk.length;
    if (characters <= MAX_ANSWER_DRAFT_CHARACTERS) rawDraft += chunk;
    else { overflow = true; rawDraft = ""; }
  };
  const finalize = () => {
    finalized = true;
    return session.finalize({ terminal, rawDraft, rawDraftHash: draftHash ??= hash.digest("hex"),
      rawDraftCharacters: characters, draftOverflow: overflow });
  };
  try {
  try {
    for await (const event of source) {
      if (event.type === "tool_result") await session.observeToolResult(event);
      if (event.type === "runtime_terminal") {
        if (terminal) failed = true;
        terminal = event.runtimeTerminal ?? null;
      }
      if (event.type === "error") failed = true;
      if (event.type === "text") { streamedSegment = true; add(event.content ?? ""); }
      else if (event.type === "result") {
        if (!streamedSegment && event.content !== "success") add(event.content ?? "");
        streamedSegment = false;
      } else if (event.type === "direct_answer") add(event.content ?? "");
      if (event.type === "done") { done = event; continue; }
      if (session.mode === "shadow") {
        const { toolResultDetails: _privateDetails, ...publicEvent } = event;
        yield publicEvent; continue;
      }
      if (["text", "result", "direct_answer", "reasoning", "runtime_terminal"].includes(event.type)) continue;
      const { toolResultDetails: _privateDetails, ...publicEvent } = event;
      yield publicEvent;
    }
  } catch (error) {
    failed = true;
    yield { type: "error", message: error instanceof Error ? error.message : String(error) };
  }
  if ((failed || terminal?.cleanupStatus === "failed") && terminal?.status === "completed") terminal = { ...terminal, status: "failed" };
  const decision = await finalize();
  if (session.mode === enforceMode) {
    yield { type: "text", content: decision.renderedText, answerPhase: "committed" };
    yield { type: "result", content: decision.renderedText, answerPhase: "committed" };
  }
  yield { type: "answer_evidence", answerEvidence: summary(decision) };
  if (session.mode === enforceMode) {
    const deliveredTerminal: AgentRuntimeTerminal = terminal
      ? { ...terminal, completionScope: "answer_delivery", runtimeStatus: terminal.status }
      : { schemaVersion: "agent-runtime-terminal.v1", status: "failed", cleanupStatus: "failed",
        completionScope: "answer_delivery", error: "Runtime terminal was not received" };
    if (!decision.auditPersisted || decision.auditIncomplete) { deliveredTerminal.status = "failed";
      deliveredTerminal.error = decision.auditIncomplete ? "Answer audit is incomplete; only an unknown conclusion can be shown" : "Answer audit could not be committed"; }
    yield { type: "runtime_terminal", runtimeTerminal: deliveredTerminal };
  }
  yield done ?? { type: "done" };
  } finally {
    if (!finalized) {
      // AsyncGenerator.return() closes the upstream first, including Pi's
      // cleanup finally. It may discard the upstream's terminal event. Audit
      // completion must not require another client pull or invent success.
      terminal = terminal
        ? { ...terminal, status: terminal.status === "aborted" ? "aborted" : "failed",
          completionScope: "answer_delivery", runtimeStatus: terminal.status,
          error: terminal.error ?? "Answer stream closed before final evidence delivery" }
        : { schemaVersion: "agent-runtime-terminal.v1", status: "failed", cleanupStatus: "failed",
          completionScope: "answer_delivery",
          error: "Answer stream closed before a runtime terminal was observed; cleanup completion is unknown" };
      await finalize();
    }
  }
}
