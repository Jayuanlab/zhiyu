import { describe, expect, it } from "vitest";
import {
  canSeedMemoryCorrection, clearPendingMemoryCorrection, memoryCorrectionRecoveryKey,
  normalizeMemoryCorrectionRequest, normalizePendingMemoryCorrection, parseMemoryCorrectionResponse,
  persistPendingMemoryCorrection, readPendingMemoryCorrection, sameMemoryCorrectionCommand,
  type MemoryCorrectionResponse, type PendingMemoryCorrection,
} from "@/components/memory-correction-recovery";

const memoryId = "00000000-0000-4000-8000-000000000001";
const draftId = "00000000-0000-4000-8000-000000000002";
const observationId = "00000000-0000-4000-8000-000000000003";
const receiptId = "00000000-0000-4000-8000-000000000004";
const version = `bmrv1:${"a".repeat(64)}`;
const newerVersion = `bmrv1:${"b".repeat(64)}`;
const intent = " \n完整改为：我现在喜欢喝茶。\n ";
const content = "我现在喜欢喝茶。";
const at = "2026-10-02T12:00:00.000Z";
function pending(): PendingMemoryCorrection {
  return { kind: "memory_correction_draft_pending.v1", ownerId: "owner-one", memoryId,
    request: { commandId: "original-draft-command", expectedVersion: version, intent }, result: null };
}
function response(): MemoryCorrectionResponse {
  const start = intent.indexOf(content);
  return { draft: { id: draftId, commandId: "original-draft-command", memoryId, expectedVersion: version, intent,
    outcome: "ready", operation: "correct", content, reason: "主人明确提供完整正文，仍需核对来源。", authority: null, sourceObservedAt: null,
    evidenceRefs: [`brain-observation:${observationId}`], quote: { start, end: start + content.length, text: content },
    questions: [], provider: "deterministic_rules", detail: "explicit_complete_correct",
    warnings: ["owner_review_required", "proves_owner_expression_only", "semantic_quality_not_evaluated"], createdAt: at },
    receipt: { id: receiptId, commandId: "original-draft-command", memoryId, expectedVersion: version, draftId,
      observationId, draftVersion: `bmcd1:${"c".repeat(64)}`, createdAt: at, effective: false },
    current: { memoryId, version, status: "active", expiresAt: null, versionMatches: true, canSeed: true }, replayed: false };
}
function storage() {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}
function ready() { return { ...pending(), result: response() }; }

describe("memory correction draft recovery", () => {
  it("preserves the exact original intent and normalizes only the command identifier", () => {
    expect(normalizeMemoryCorrectionRequest({ ...pending().request, commandId: "  original-draft-command  " })).toEqual(pending().request);
  });
  it("rejects hidden null characters and extra request fields before persistence", () => {
    expect(() => normalizeMemoryCorrectionRequest({ ...pending().request, intent: "original\0statement" })).toThrow();
    expect(() => normalizeMemoryCorrectionRequest({ ...pending().request, evidenceRefs: ["caller:fake"] })).toThrow();
  });
  it("accepts a linked non-effective receipt and a verbatim version-bound suggestion", () => {
    expect(parseMemoryCorrectionResponse(response(), pending())).toEqual(response());
    expect(canSeedMemoryCorrection(ready(), memoryId, version)).toBe(true);
  });
  it("allows a clarification quotation but never uses it as replacement text", () => {
    const value = response();
    value.draft = { ...value.draft, outcome: "needs_clarification", operation: null, content: null, reason: null,
      quote: { start: 0, end: intent.length, text: intent }, questions: ["请提供明确的新正文。"] };
    expect(parseMemoryCorrectionResponse(value, pending()).draft.quote?.text).toBe(intent);
    expect(canSeedMemoryCorrection({ ...pending(), result: value }, memoryId, version)).toBe(false);
    value.draft.quote = null;
    expect(parseMemoryCorrectionResponse(value, pending()).draft.quote).toBeNull();
  });
  it("requires an original quotation for a ready draft", () => {
    const value = response(); value.draft.quote = null;
    expect(() => parseMemoryCorrectionResponse(value, pending())).toThrow();
  });
  it("requires the full non-deactivation content to equal its quoted original span", () => {
    const value = response(); value.draft.content = "A fabricated extra claim";
    expect(() => parseMemoryCorrectionResponse(value, pending())).toThrow();
    value.draft.content = content; value.draft.quote!.start += 1;
    expect(() => parseMemoryCorrectionResponse(value, pending())).toThrow();
  });
  it("measures verbatim quotation offsets in UTF-16 without changing emoji or surrounding whitespace", () => {
    const record = pending(); record.request.intent = " \n完整改为：我喜欢茶🍵。\n ";
    const value = response(); const text = "我喜欢茶🍵。"; const start = record.request.intent.indexOf(text);
    value.draft = { ...value.draft, intent: record.request.intent, content: text, quote: { start, end: start + text.length, text } };
    expect(parseMemoryCorrectionResponse(value, record).draft.quote).toEqual(value.draft.quote);
  });
  it("allows explicit deactivation only as a non-effective suggestion", () => {
    const record = pending(); record.request.intent = "停用这条记忆";
    const value = response(); value.draft = { ...value.draft, intent: record.request.intent, operation: "deactivate", content: null,
      quote: { start: 0, end: record.request.intent.length, text: record.request.intent } };
    expect(parseMemoryCorrectionResponse(value, record).receipt.effective).toBe(false);
  });
  it.each(["authority", "sourceObservedAt"])("does not accept parser-provided %s authority", field => {
    const value: any = response(); value.draft[field] = field === "authority" ? "owner_statement" : at;
    expect(() => parseMemoryCorrectionResponse(value, pending())).toThrow();
  });
  it.each(["commandId", "memoryId", "expectedVersion", "draftId", "observationId", "draftVersion", "effective"])("rejects a mismatched receipt %s", field => {
    const value: any = response(); value.receipt[field] = field === "effective" ? true : "wrong-receipt-field";
    expect(() => parseMemoryCorrectionResponse(value, pending())).toThrow();
  });
  it("requires the server-generated observation reference rather than caller-supplied evidence", () => {
    const value = response(); value.draft.evidenceRefs = ["caller:assertion"];
    expect(() => parseMemoryCorrectionResponse(value, pending())).toThrow();
  });
  it("keeps historical replay separate from the current version and blocks seeding an obsolete draft", () => {
    const value = response(); value.replayed = true;
    value.current = { ...value.current, version: newerVersion, versionMatches: false, canSeed: false };
    expect(parseMemoryCorrectionResponse(value, pending()).draft.expectedVersion).toBe(version);
    expect(canSeedMemoryCorrection({ ...pending(), result: value }, memoryId, newerVersion)).toBe(false);
    expect(canSeedMemoryCorrection(ready(), memoryId, newerVersion)).toBe(false);
    expect(canSeedMemoryCorrection(ready(), draftId, version)).toBe(false);
  });
  it("rejects contradictory current flags and retired versions marked seedable", () => {
    const value = response(); value.current.versionMatches = false;
    expect(() => parseMemoryCorrectionResponse(value, pending())).toThrow();
    value.current.versionMatches = true; value.current.status = "superseded";
    expect(() => parseMemoryCorrectionResponse(value, pending())).toThrow();
  });
  it("does not accept replacement fields in a clarification response", () => {
    const value = response(); value.draft.outcome = "needs_clarification"; value.draft.questions = ["Clarify"];
    expect(() => parseMemoryCorrectionResponse(value, pending())).toThrow();
  });
  it("rejects ready drafts that still ask questions and receipt dates detached from their immutable draft", () => {
    const value = response(); value.draft.questions = ["Is this really a correction?"];
    expect(() => parseMemoryCorrectionResponse(value, pending())).toThrow();
    value.draft.questions = []; value.receipt.createdAt = "2026-10-02T12:00:01.000Z";
    expect(() => parseMemoryCorrectionResponse(value, pending())).toThrow();
  });
  it("restores only the authenticated owner's exact bounded command", () => {
    const store = storage(); persistPendingMemoryCorrection(store, pending());
    expect(readPendingMemoryCorrection(store, "owner-one")).toEqual(pending());
    expect(readPendingMemoryCorrection(store, "owner-two")).toBeNull();
    expect(() => normalizePendingMemoryCorrection(pending(), "owner-two")).toThrow();
    expect(() => normalizePendingMemoryCorrection({ ...pending(), request: { ...pending().request, status: "active" } }, "owner-one")).toThrow();
  });
  it("fails closed on malformed or empty slots without deleting their evidence", () => {
    const store = storage(); const key = memoryCorrectionRecoveryKey("owner-one");
    for (const raw of ["", "{broken", JSON.stringify({ ...pending(), result: {} })]) {
      store.values.set(key, raw);
      expect(() => readPendingMemoryCorrection(store, "owner-one")).toThrow();
      expect(store.values.get(key)).toBe(raw);
    }
  });
  it("requires successful storage readback before a request can be sent", () => {
    expect(() => persistPendingMemoryCorrection({ getItem: () => null, setItem: () => { throw new Error("quota"); } }, pending())).toThrow("quota");
    expect(() => persistPendingMemoryCorrection({ getItem: () => null, setItem: () => undefined }, pending())).toThrow();
  });
  it("refuses to overwrite another command or alter the original payload", () => {
    const store = storage(); persistPendingMemoryCorrection(store, pending());
    for (const request of [{ ...pending().request, commandId: "other" }, { ...pending().request, intent: "different original statement" },
      { ...pending().request, expectedVersion: newerVersion }]) {
      expect(() => persistPendingMemoryCorrection(store, { ...pending(), request })).toThrow();
      expect(readPendingMemoryCorrection(store, "owner-one")).toEqual(pending());
    }
  });
  it("preserves a received draft instead of lowering it to unknown", () => {
    const store = storage(); persistPendingMemoryCorrection(store, ready());
    expect(() => persistPendingMemoryCorrection(store, pending())).toThrow();
    expect(readPendingMemoryCorrection(store, "owner-one")).toEqual(ready());
  });
  it("refreshes current state but never replaces the saved immutable draft or receipt", () => {
    const store = storage(); persistPendingMemoryCorrection(store, ready());
    const refreshed = ready(); refreshed.result.replayed = true;
    refreshed.result.current = { ...refreshed.result.current, version: newerVersion, versionMatches: false, canSeed: false };
    persistPendingMemoryCorrection(store, refreshed);
    expect(readPendingMemoryCorrection(store, "owner-one")).toEqual(refreshed);
    refreshed.result.draft.reason = "different interpretation";
    expect(() => persistPendingMemoryCorrection(store, refreshed)).toThrow();
  });
  it("clears only the exact normalized record and confirms the slot is actually absent", () => {
    const store = storage(); persistPendingMemoryCorrection(store, ready());
    expect(() => clearPendingMemoryCorrection(store, pending())).toThrow();
    expect(readPendingMemoryCorrection(store, "owner-one")).toEqual(ready());
    clearPendingMemoryCorrection(store, ready());
    expect(store.getItem(memoryCorrectionRecoveryKey("owner-one"))).toBeNull();
    const unchanged = storage(); persistPendingMemoryCorrection(unchanged, ready());
    expect(() => clearPendingMemoryCorrection({ getItem: unchanged.getItem, removeItem: () => undefined }, ready())).toThrow();
  });
  it("normalizes key order while still comparing owner, memory, command and the complete original payload", () => {
    const original = pending();
    const reordered = normalizePendingMemoryCorrection({ result: null, request: { intent, expectedVersion: version, commandId: "original-draft-command" },
      memoryId, ownerId: "owner-one", kind: "memory_correction_draft_pending.v1" }, "owner-one");
    expect(sameMemoryCorrectionCommand(original, reordered)).toBe(true);
    expect(sameMemoryCorrectionCommand(original, { ...reordered, ownerId: "owner-two" })).toBe(false);
    expect(sameMemoryCorrectionCommand(original, { ...reordered, memoryId: draftId })).toBe(false);
  });
});
