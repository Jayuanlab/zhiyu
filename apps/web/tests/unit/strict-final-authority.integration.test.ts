import { describe, expect, it, vi } from "vitest";
import { createAnswerEvidenceSession } from "@/lib/ai/runtime/answer-evidence-session";
import { createPlatformAnswerSession } from "@/lib/ai/runtime/platform-answer-session";
import type { AnswerEvidenceAuditEvent, ToolConstruction } from "@/lib/ai/runtime/answer-evidence-contract";
import type { AgentRuntimeTerminal } from "@openzhiyu/ai/agent/types";

const id = "11111111-1111-4111-8111-111111111111";
const at = "2026-10-04T01:00:00.000Z";
const secret = "private-authority-fixture-secret";
const terminal: AgentRuntimeTerminal = { schemaVersion: "agent-runtime-terminal.v1", status: "completed", cleanupStatus: "completed" };
type Kind = "platform" | "loop";
function setup(kind: Kind, options: { authority?: () => Promise<boolean>; missingAuthority?: boolean; auditSink?: (event: AnswerEvidenceAuditEvent) => Promise<unknown> } = {}) {
  const audits: AnswerEvidenceAuditEvent[] = [];
  const authority = options.authority ?? vi.fn(async () => true);
  const shared = { mode: "enforce_supported" as const, ownerId: "owner", turnId: "turn", runtimeHash: "runtime", policyHash: "policy",
    now: () => new Date(at), auditSink: options.auditSink ?? (async (event: AnswerEvidenceAuditEvent) => { audits.push(event); }),
    authorizeFinal: options.missingAuthority ? undefined : authority };
  const session = kind === "platform"
    ? createPlatformAnswerSession({ ...shared, question: `chat ${id} \u7684\u6807\u9898\u662f\u4ec0\u4e48\uff1f` })
    : createAnswerEvidenceSession({ ...shared, mode: "enforce_critical", question: `Loop ${id} \u5f53\u524d\u662f\u5426\u6b63\u5728\u8fd0\u884c\uff1f` });
  return { session, authority, audits };
}
async function registerSyntheticObservation(kind: Kind, session: ReturnType<typeof setup>["session"]) {
  const result = kind === "platform"
    ? { ok: true, data: { records: { observedAt: at, records: [{ source: "chat", id, fields: { title: secret }, fieldAvailability: { title: "shown" } }] } } }
    : { ok: true, runtime: { provider: "workshop_execution_leases", loopId: id, observedAt: at,
      status: "no_active_linked_execution_observed", observationScope: "active_linked_execution_mapping_only", linkedExecution: null,
      loopConfiguration: { status: "active", updatedAt: at } } };
  const input: ToolConstruction = { toolCallId: "read-1", toolName: "platformRecall", params: { fixture: true }, result, modelText: JSON.stringify(result),
    trace: { type: "tool_result", title: "completed", detail: null, toolName: "platformRecall", toolUseId: "read-1", status: "completed", timestamp: at, durationMs: 1,
      metadata: { decision: "allow", reason: "fixture-allowed", matchedRule: "platformRecall", deniedBeforeHandler: false } } };
  await session.observeToolConstruction(input);
  await session.observeToolResult({ type: "tool_result", toolUseId: input.toolCallId, output: input.modelText, isError: false, toolResultDetails: { result: input.result, trace: input.trace } });
  // A controlled unit receipt exercises the core's matching gate. This is not
  // an installed SDK, provider, model, or real permission-service observation.
  await session.observeContextCommitted({ toolCallId: input.toolCallId, entryId: "synthetic-unit-context", modelText: input.modelText! });
}
const invalidAuthorities: Array<[string, unknown]> = [
  ["undefined", undefined], ["null", null], ["zero", 0], ["one", 1], ["false-string", "false"], ["true-string", "true"],
  ["empty-object", {}], ["allowed-object", { allowed: true }], ["empty-array", []], ["boxed-true", new Boolean(true)],
];
describe.each<Kind>(["platform", "loop"])("literal final authority in the real %s adapter", kind => {
  it.each(invalidAuthorities)("withholds previously delivered observations on runtime-invalid authority %s", async (_label, value) => {
    const authority = vi.fn(async () => value) as unknown as ReturnType<typeof vi.fn<() => Promise<boolean>>>;
    const { session } = setup(kind, { authority });
    expect(session.supported).toBe(true);
    await registerSyntheticObservation(kind, session);
    const decision = await session.finalize({ terminal, rawDraft: secret });
    expect(decision.outcome).toBe("unknown");
    expect(decision.evidenceRefs).toEqual([]);
    expect(decision.resolutions.length).toBeGreaterThan(0);
    expect(decision.resolutions.every(item => item.state === "denied")).toBe(true);
    expect(decision.renderedText).not.toContain(secret);
    expect(decision.auditPersisted).toBe(true);
    expect(authority).toHaveBeenCalledOnce();
  });
  it("preserves normal literal true authorization", async () => {
    const { session, authority } = setup(kind);
    await registerSyntheticObservation(kind, session);
    const decision = await session.finalize({ terminal, rawDraft: secret });
    expect(decision.outcome).toBe("supported_fields");
    expect(decision.evidenceRefs).not.toEqual([]);
    expect(decision.auditPersisted).toBe(true);
    expect(decision.auditIncomplete).toBe(false);
    if (kind === "platform") expect(decision.renderedText).toContain(secret);
    expect(authority).toHaveBeenCalledOnce();
  });
  it("keeps literal false denied across concurrent and repeated finalization", async () => {
    const authority = vi.fn<() => Promise<boolean>>().mockResolvedValueOnce(false).mockResolvedValue(true);
    const { session } = setup(kind, { authority }); await registerSyntheticObservation(kind, session);
    const input = { terminal, rawDraft: secret };
    const [first, concurrent] = await Promise.all([session.finalize(input), session.finalize({ ...input, rawDraft: "later-draft" })]);
    const repeat = await session.finalize(input);
    expect(first).toBe(concurrent); expect(first).toBe(repeat);
    expect(first.outcome).toBe("unknown"); expect(first.evidenceRefs).toEqual([]);
    expect(first.renderedText).not.toContain(secret); expect(first.renderedText).not.toContain("later-draft");
    expect(authority).toHaveBeenCalledOnce();
  });
  it("records authority read failure and withholds observed and draft values", async () => {
    const authority = vi.fn(async () => { throw Error("synthetic-authority-unavailable"); });
    const { session, audits } = setup(kind, { authority }); await registerSyntheticObservation(kind, session);
    const decision = await session.finalize({ terminal, rawDraft: secret });
    expect(decision.outcome).toBe("unknown"); expect(decision.evidenceRefs).toEqual([]);
    expect(decision.renderedText).not.toContain(secret);
    const runtimeAudit = audits.find(event => event.eventType === "runtime_terminal");
    expect(runtimeAudit?.payload.gaps).toContain("authorization_read_failed");
    expect(authority).toHaveBeenCalledOnce();
  });
  it("does not grant when the final host authority is absent", async () => {
    const { session } = setup(kind, { missingAuthority: true }); await registerSyntheticObservation(kind, session);
    const decision = await session.finalize({ terminal, rawDraft: secret });
    expect(decision.outcome).toBe("unknown"); expect(decision.evidenceRefs).toEqual([]);
    expect(decision.resolutions.every(item => item.state === "denied")).toBe(true);
    expect(decision.renderedText).not.toContain(secret);
  });
  it.each(["runtime_terminal", "final_evidence", "turn_completed"])("does not commit a verified conclusion after a recoverable %s audit failure", async failedType => {
    const saved: AnswerEvidenceAuditEvent[] = []; let failed = false;
    const auditSink = async (event: AnswerEvidenceAuditEvent) => {
      if (!failed && event.eventType === failedType) { failed = true; throw Error("synthetic-audit-failure"); }
      saved.push(event);
    };
    const { session } = setup(kind, { auditSink }); await registerSyntheticObservation(kind, session);
    const decision = await session.finalize({ terminal, rawDraft: secret });
    expect(failed).toBe(true); expect(decision.outcome).toBe("unknown");
    expect(decision.evidenceRefs).toEqual([]); expect(decision.renderedText).not.toContain(secret);
    expect(decision.auditIncomplete).toBe(true); expect(decision.auditPersisted).toBe(true);
    const closing = saved.at(-1);
    expect(closing?.eventType).toBe("turn_failed");
    expect(closing?.payload.terminal).toMatchObject({ status: "failed", runtimeStatus: "completed", completionScope: "answer_delivery" });
  });
});
