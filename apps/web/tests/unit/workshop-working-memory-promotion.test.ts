import { describe, expect, it } from "vitest";
import type { Context } from "@earendil-works/pi-ai";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createHostWorkingMemory } from "@openzhiyu/ai/agent/runtime/host-working-memory";
import type { WorkshopEvent } from "@/lib/workshops/run-history-types";
import { parseWorkingMemoryPromotionCommand, resolveWorkingMemoryPromotion, WorkingMemoryPromotionError } from "@/lib/workshops/working-memory-promotion";
import { loopPromotionEvents, promotionEvents, promotionLoopId, promotionRunId, promotionUserId, promotionWorkId } from "../fixtures/working-memory-promotion";

const command = () => parseWorkingMemoryPromotionCommand({ runKind: "workshop", runId: promotionRunId, noteKey: "paper:method", expectedVersion: 1, commandId: "promotion-1" });
const resolve = (events = promotionEvents()) => resolveWorkingMemoryPromotion({ userId: promotionUserId, workshopId: promotionWorkId, command: command(), events });
const failure = (run: () => unknown, code: string) => {
  try { run(); throw Error("Expected rejection"); } catch (error) { expect(error).toBeInstanceOf(WorkingMemoryPromotionError); expect((error as WorkingMemoryPromotionError).code).toBe(code); }
};
function entry(events: ReturnType<typeof promotionEvents>, index: number) { return (events[index].metadata.evidenceCatalog as Record<string, unknown>[])[0]; }

describe("exact working note promotion", () => {
  it("requires explicit run kind and Loop identity instead of guessing colliding IDs", () => {
    const { runKind: _kind, ...legacy } = command();
    failure(() => parseWorkingMemoryPromotionCommand(legacy), "invalid_promotion_command");
    failure(() => parseWorkingMemoryPromotionCommand({ ...command(), runKind: "loop" }), "invalid_promotion_command");
    failure(() => parseWorkingMemoryPromotionCommand({ ...command(), loopId: promotionLoopId }), "invalid_promotion_command");
    failure(() => resolve(loopPromotionEvents()), "no_current_working_note");
  });
  it("binds a Loop run independently of its workshop execution run ID", () => {
    const events = loopPromotionEvents();
    const loopCommand = parseWorkingMemoryPromotionCommand({ ...command(), runKind: "loop", loopId: promotionLoopId });
    const run = () => resolveWorkingMemoryPromotion({ userId: promotionUserId, workshopId: promotionWorkId, command: loopCommand, events });
    const result = run();
    expect(result.runIdentity).toEqual({ runKind: "loop", loopId: promotionLoopId, runId: promotionRunId });
    expect(result.runId).toBe(events[1].runId);
    expect(result.loopRunId).toBe(promotionRunId);
    expect(result.candidateId).not.toBe(resolve().candidateId);
    events[0].loopId = "77777777-7777-4777-a777-777777777777";
    failure(run, "source_scope_mismatch");
  });
  it("rejects Loop source event ID and source version changes", () => {
    const events = loopPromotionEvents();
    const loopCommand = parseWorkingMemoryPromotionCommand({ ...command(), runKind: "loop", loopId: promotionLoopId });
    const run = () => resolveWorkingMemoryPromotion({ userId: promotionUserId, workshopId: promotionWorkId, command: loopCommand, events });
    events[0].loopRunId = "77777777-7777-4777-a777-777777777777";
    failure(run, "source_scope_mismatch");
    events[0].loopRunId = promotionRunId;
    events[0].metadata.sourceVersion = "changed";
    failure(run, "source_version_conflict");
  });
  it("binds the persisted note, matching request preparation and exact durable window without claiming truth", () => {
    const events = promotionEvents(), original = structuredClone(events), result = resolve(events);
    expect(result.content).toBe("来源只覆盖第一段，结论仍需核验。");
    expect(result.evidenceRefs).toEqual([events[0].id]);
    expect(result.sources[0]).toMatchObject({ provider: "fixture", sourceVersionKind: "content_hash", sourceVersion: `sha256:${"a".repeat(64)}`,
      span: { offset: 0, contentLength: 1000, totalChars: 2000 }, finalUrlVerified: false, warningTexts: ["科学结论仍需核对。"] });
    expect(result.candidateId).toMatch(/^[a-f0-9-]{36}$/);
    expect(resolve(events).candidateId).toBe(result.candidateId);
    expect(resolveWorkingMemoryPromotion({ userId: promotionUserId, workshopId: promotionWorkId, command: { ...command(), commandId: "promotion-retry" }, events }).candidateId).toBe(result.candidateId);
    expect(events).toEqual(original);
  });
  it.each([{ content: "Self-reported fact" }, { sourceEventIds: ["fake"] }, { status: "active" }])("rejects caller-added claim, source or activation fields %j", extra => {
    failure(() => parseWorkingMemoryPromotionCommand({ ...command(), ...extra }), "invalid_promotion_command");
  });
  it("requires the current accepted version and a later prepared request", () => {
    const events = promotionEvents(); events[1].metadata.version = 2;
    failure(() => resolve(events), "working_memory_version_conflict");
    failure(() => resolve(promotionEvents().slice(0, 2)), "working_note_not_consumed");
    const prepared = promotionEvents(); prepared[2].metadata.version = 0;
    failure(() => resolve(prepared), "working_note_not_consumed");
  });
  it("never promotes a shadow, restored, truncated or rejected candidate state", () => {
    for (const type of ["working_memory_restored", "working_memory_rejected"]) {
      const events = promotionEvents(); events[1].type = type;
      failure(() => resolve(events), "no_current_working_note");
    }
    const shadow = promotionEvents(); shadow[1].metadata.mode = "shadow";
    failure(() => resolve(shadow), "no_current_working_note");
    const truncated = promotionEvents(); truncated[1].metadata.__truncated = true;
    failure(() => resolve(truncated), "truncated_working_note");
  });
  it("rejects local reads without a durable mapping instead of attaching recent events", () => {
    const events = promotionEvents();
    for (const index of [1, 2]) { entry(events, index).sourceIdentity = {}; entry(events, index).sourceIdentityStatus = "missing"; }
    failure(() => resolve(events), "source_identity_conflict");
  });
  it.each(["contentHash", "offset", "contentLength", "totalChars", "evidenceId"])("rejects changed source window field %s", field => {
    const events = promotionEvents(); events[0].metadata[field] = field.includes("Hash") ? "d".repeat(64) : field === "evidenceId" ? "other-page" : 900;
    failure(() => resolve(events), "source_window_conflict");
  });
  it.each(["workshopId", "runId"])("rejects a source belonging to another %s", field => {
    const events = promotionEvents(); events[0][field as "runId"] = "77777777-7777-4777-a777-777777777777";
    failure(() => resolve(events), "source_scope_mismatch");
  });
  it.each([{ toolUseId: "other-call" }, { receiptAuthority: "agent" }, { ok: false }, { toolName: "read" }])("requires an exact host tool binding %j", patch => {
    const events = promotionEvents(); Object.assign(events[0].metadata, patch);
    failure(() => resolve(events), "source_not_bound");
  });
  it.each([{ revoked: true }, { status: "superseded" }, { status: "unknown" }, { expiresAt: "2000-01-01T00:00:00.000Z" }, { expiresAt: "invalid" }])("rejects inactive or unknown source currency %j", patch => {
    const events = promotionEvents(); Object.assign(events[0].metadata, patch);
    failure(() => resolve(events), "source_not_current");
  });
  it("keeps hypotheses as hypotheses and rejects an ambiguous duplicate note key", () => {
    const events = promotionEvents(), state = events[1].metadata.state as any;
    const factId = resolve(events).candidateId;
    state.hypotheses = state.facts; state.facts = [];
    expect(resolve(events).category).toBe("hypothesis");
    expect(resolve(events).candidateId).not.toBe(factId);
    state.facts = state.hypotheses;
    failure(() => resolve(events), "unknown_working_note");
  });
  it("rejects conflicting prepared identities, policies, later invalidation and unbounded history", () => {
    const identity = promotionEvents(); entry(identity, 2).contentHash = "d".repeat(64);
    failure(() => resolve(identity), "source_identity_conflict");
    const policy = promotionEvents(); policy[2].metadata.policyIdentity = { version: "other", hash: "e".repeat(64) };
    failure(() => resolve(policy), "memory_policy_conflict");
    const changed = promotionEvents(); changed.push({ ...changed[0], id: "77777777-7777-4777-a777-777777777777", seq: 4,
      metadata: { receiptAuthority: "runtime", evidenceId: "saved-page", contentHash: "d".repeat(64) } });
    failure(() => resolve(changed), "source_not_current");
    failure(() => resolve(Array.from({ length: 2001 }, () => promotionEvents()[0])), "promotion_history_limit");
  });

  it("admits exact web source windows emitted by the host while retaining projection-blocking cautions", async () => {
    const source = promotionEvents()[0];
    const events: WorkshopEvent[] = [source];
    const record = (type: string, metadata: object) => {
      const seq = events.length + 1;
      events.push({ ...source, id: `77777777-7777-4777-a777-${String(seq).padStart(12, "0")}`, seq, type,
        metadata: { ...metadata, receiptAuthority: "runtime" } });
    };
    const gate = createHostWorkingMemory({ signal: new AbortController().signal, options: {
      mode: "apply", readonlyToolNames: ["webReadPage"],
      policyIdentity: { version: "memact-automem.v1", hash: "c".repeat(64) },
      onAudit: metadata => record("working_memory_updated", metadata),
      onProjection: metadata => record("working_memory_projected", metadata),
    } });
    const context: Context = { messages: [
      fauxAssistantMessage({ ...fauxToolCall("webReadPage", { evidenceId: "saved-page" }), id: "read-1" }, { stopReason: "toolUse" }),
      { role: "toolResult", toolCallId: "read-1", toolName: "webReadPage", isError: false, timestamp: 1,
        content: [{ type: "text", text: JSON.stringify({ ok: true, sourceEventId: source.id, evidenceId: "saved-page",
          contentHash: "a".repeat(64), content: "x".repeat(1000), offset: 0, contentLength: 1000, totalChars: 2000,
          provider: "fixture", finalUrlVerified: false, warnings: ["extraction_not_independently_verified"] }) }] },
    ] };
    const original = structuredClone(context);
    const faux = createFauxCore({});
    faux.setResponses([fauxAssistantMessage("ready"), fauxAssistantMessage("ready")]);
    const dispatch = () => gate.wrapStream((...args) => faux.streamSimple(...args))(faux.getModel(), context);
    await dispatch();
    expect(await gate.manage({ operation: "update", commandId: "log-1", expectedVersion: 0, phase: "LOG",
      state: { facts: [{ key: "paper:method", text: "The observed source still requires owner review.", evidenceIds: ["read-1"] }],
        hypotheses: [], openQuestions: [], nextAction: { text: "Verify the original source.", evidenceIds: ["read-1"] } },
      pruneToolCallIds: [],
    })).toMatchObject({ ok: true });
    failure(() => resolve(events), "working_note_not_consumed");
    await dispatch();
    const result = resolve(events);
    expect(result.evidenceRefs).toEqual([source.id]);
    expect(result.sources[0]).toMatchObject({ contentHash: "a".repeat(64), sourceVersionKind: "content_hash",
      span: { offset: 0, contentLength: 1000, totalChars: 2000 }, warningCodes: ["extraction_not_independently_verified"] });
    const prepared = events.at(-1)!;
    expect((prepared.metadata.evidenceCatalog as Record<string, unknown>[])[0]).toMatchObject({ referenceEligible: true, projectionEligible: false });
    expect(context).toEqual(original);
  });
});
