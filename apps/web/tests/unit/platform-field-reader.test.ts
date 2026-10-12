import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { PlatformReadHandleRegistry, type PlatformFieldReadBinding, type PlatformReadHandle } from "@/lib/ai/platform-read-handle-registry";
import { readPlatformWholeField, readPlatformRelatedChatTitle, platformPublishedRecordHash, attachPlatformReadHandlesToResult, type PlatformPublishedFieldRecord, type PlatformRelatedChatTitleSubject } from "@/lib/ai/platform-field-reader";
import { createMemoryReadBudget } from "@/lib/ai/memory-read-budget";

const id = "3c4be88b-947f-465d-9ce3-aff28891d274";
const child = "44861dfc-916f-431f-899b-364ca54f0aa1";
const identity = { ownerId: "owner", requester: { kind: "chat" as const, id: "chat" }, turnId: "turn-a" };
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const record = (fields: Record<string, unknown>, source = "loopRuns", recordId = id): PlatformPublishedFieldRecord => ({ source, id: recordId, fields: { id: recordId, ...fields } });
const prepare = (value = record({ outputSummary: "concrete result" }), fieldKey = "outputSummary") => {
  const registry = new PlatformReadHandleRegistry(identity);
  const handle = registry.register({ source: value.source, id: value.id, fieldKey, contentHash: platformPublishedRecordHash(value) });
  return { registry, handle, value };
};

describe("bounded host-associated chat titles", () => {
  const parentRecord = (extra: Record<string, unknown> = {}, source = "message") => record({ chatId: child, role: "assistant", parts: [{ type: "text", text: "observed text" }], ...extra }, source);
  const question = `消息记录 ${id} 的角色、正文和所属聊天标题是什么？`;
  function context(originalQuestion = question) {
    return { originalQuestion, identity: { ...identity, requester: { ...identity.requester } }, registry: new PlatformReadHandleRegistry(identity), budget: createMemoryReadBudget() };
  }
  it.each(["message", "Message_v2"])("preserves %s parent bytes and uses the independently hashed whole child field", async source => {
    const parentRecordValue = parentRecord({}, source), childRecord = record({ title: 'literal "]} <script>payload</script>', visibility: "public" }, "chat", child);
    const ctx = context(), parentBytes = JSON.stringify(parentRecordValue), childBytes = JSON.stringify(childRecord);
    const read = vi.fn(async (subject: { source: string; id: string }) => subject.source === "chat" ? childRecord : parentRecordValue);
    const result = await readPlatformRelatedChatTitle({ userId: identity.ownerId, parent: parentRecordValue, parentContentHash: platformPublishedRecordHash(parentRecordValue), context: ctx }, read);
    expect(result).toMatchObject({ status: "read", fieldRead: { source: "chat", id: child, parentContentHash: platformPublishedRecordHash(childRecord),
      fields: [{ fieldKey: "title", value: childRecord.fields.title, valueHash: digest(JSON.stringify(childRecord.fields.title)), complete: true }] } });
    expect(result?.fieldRead?.parentContentHash).not.toBe(platformPublishedRecordHash(parentRecordValue));
    expect(read.mock.calls.map(call => call[0])).toEqual([{ source: "chat", id: child }, { source, id }]);
    expect(JSON.stringify(parentRecordValue)).toBe(parentBytes); expect(JSON.stringify(childRecord)).toBe(childBytes);
    expect(ctx.budget.snapshot()).toMatchObject({ attempts: 2, inFlight: 0 });
  });
  it.each([`消息记录 ${id} 的角色是什么？`, `消息记录 ${child} 的所属聊天标题是什么？`, `请修改消息记录 ${id} 所属聊天标题`])("does not expand outside the original subject/title contract: %s", async originalQuestion => {
    const parentValue = parentRecord(), ctx = context(originalQuestion), read = vi.fn();
    expect(await readPlatformRelatedChatTitle({ userId: identity.ownerId, parent: parentValue, parentContentHash: platformPublishedRecordHash(parentValue), context: ctx }, read)).toBeUndefined();
    expect(read).not.toHaveBeenCalled(); expect(ctx.budget.snapshot().attempts).toBe(0);
  });
  it.each([
    { chatId: null }, { chatId: [child] }, { chatId: "not-an-id" }, { chatId: child, chat_id: id }, { chatId: child, chat_id: null },
  ])("rejects invalid/conflicting relation fields without another source query", async extra => {
    const parentValue = parentRecord(extra), ctx = context(), read = vi.fn();
    const result = await readPlatformRelatedChatTitle({ userId: identity.ownerId, parent: parentValue, parentContentHash: platformPublishedRecordHash(parentValue), context: ctx }, read);
    expect(result?.status).toBe("invalid_relation"); expect(read).not.toHaveBeenCalled(); expect(ctx.budget.snapshot().attempts).toBe(0);
  });
  it("does not use inherited chat identity or a mismatched parent hash", async () => {
    const parentValue = parentRecord(); delete parentValue.fields.chatId;
    Object.setPrototypeOf(parentValue.fields, { chatId: child });
    const ctx = context(), read = vi.fn();
    expect((await readPlatformRelatedChatTitle({ userId: identity.ownerId, parent: parentValue, parentContentHash: platformPublishedRecordHash(parentValue), context: ctx }, read))?.status).toBe("invalid_relation");
    expect((await readPlatformRelatedChatTitle({ userId: identity.ownerId, parent: parentRecord(), parentContentHash: "a".repeat(64), context: ctx }, read))?.status).toBe("invalid_relation");
    expect(read).not.toHaveBeenCalled();
  });
  it.each(["foreign_owner", "other_turn", "work", "closed"])("denies %s identity before an associated query", async vector => {
    const parentValue = parentRecord(), ctx = context(), read = vi.fn();
    if (vector === "foreign_owner") ctx.identity = { ...identity, ownerId: "other" };
    if (vector === "other_turn") ctx.identity = { ...identity, turnId: "other" };
    if (vector === "work") Object.assign(ctx.identity, { requester: { kind: "work", id: "work" } });
    if (vector === "closed") ctx.registry.close();
    expect((await readPlatformRelatedChatTitle({ userId: "owner", parent: parentValue, parentContentHash: platformPublishedRecordHash(parentValue), context: ctx }, read))?.status).toBe("permission_denied");
    expect(read).not.toHaveBeenCalled();
  });
  it.each(["changed_hash", "changed_chat", "owner_revoked", "query_error"])("withholds a successfully read child when parent recheck fails: %s", async vector => {
    const parentValue = parentRecord(), ctx = context();
    const read = vi.fn(async (subject: { source: string; id: string }) => {
      if (subject.source === "chat") return record({ title: "MUST_NOT_BE_DELIVERED" }, "chat", child);
      if (vector === "query_error") throw Error("PRIVATE DATABASE MESSAGE");
      return vector === "owner_revoked" ? null : parentRecord(vector === "changed_chat" ? { chatId: id } : { role: "user" });
    });
    const result = await readPlatformRelatedChatTitle({ userId: identity.ownerId, parent: parentValue, parentContentHash: platformPublishedRecordHash(parentValue), context: ctx }, read);
    expect(result?.fieldRead?.fields).toEqual([]); expect(result?.fieldRead?.coverage.fieldComplete).toBe(false);
    expect(JSON.stringify(result)).not.toContain("MUST_NOT_BE_DELIVERED"); expect(JSON.stringify(result)).not.toContain("PRIVATE DATABASE MESSAGE");
    expect(ctx.budget.snapshot().attempts).toBe(2);
  });
  it.each([null, "", 'quote \\ " <script>']) ("keeps whole null/empty/untrusted literal title values: %s", async title => {
    const parentValue = parentRecord(), ctx = context();
    const result = await readPlatformRelatedChatTitle({ userId: identity.ownerId, parent: parentValue, parentContentHash: platformPublishedRecordHash(parentValue), context: ctx }, async subject => subject.source === "chat" ? record({ title }, "chat", child) : parentValue);
    expect(result?.fieldRead?.fields[0]).toMatchObject({ value: title, valueHash: digest(JSON.stringify(title)), complete: true });
    expect(result?.status).toBe(title === null ? "not_recorded" : "read");
  });
  it.each(["missing", "wrong_id", "bad_title", "too_large", "query_error"])("preserves explicit child gaps: %s", async vector => {
    const parentValue = parentRecord(), ctx = context();
    const read = vi.fn(async () => {
      if (vector === "query_error") throw Error("PRIVATE CHILD ERROR");
      return vector === "missing" ? null : record({ title: vector === "bad_title" ? { text: "invalid" } : vector === "too_large" ? "x".repeat(8000) : "wrong identity" }, "chat", vector === "wrong_id" ? id : child);
    });
    const result = await readPlatformRelatedChatTitle({ userId: identity.ownerId, parent: parentValue, parentContentHash: platformPublishedRecordHash(parentValue), context: ctx }, read);
    expect(result?.fieldRead?.fields).toEqual([]); expect(result?.fieldRead?.coverage.fieldComplete).toBe(false);
    expect(read).toHaveBeenCalledOnce(); expect(ctx.budget.snapshot().attempts).toBe(1);
    expect(JSON.stringify(result)).not.toContain("PRIVATE CHILD ERROR");
  });
  it("does not query or publish a child after the shared budget is exhausted", async () => {
    const parentValue = parentRecord(), ctx = context();
    const wrapped = ctx.budget.wrap([{ name: "platformRecall", description: "budget fixture", parameters: {} as never, execute: () => ({}), formatResult: () => "{}" }])[0];
    for (let i = 0; i < 10; i++) await wrapped.execute({ i }, { toolCallId: String(i) });
    const read = vi.fn();
    const result = await readPlatformRelatedChatTitle({ userId: identity.ownerId, parent: parentValue, parentContentHash: platformPublishedRecordHash(parentValue), context: ctx }, read);
    expect(result).toMatchObject({ status: "budget_unavailable", fieldRead: { fields: [], fieldAvailability: { title: "related_read_budget_unavailable" } },
      reads: [{ stage: "chat_title", attemptCharged: false, queryAttempted: false, status: "budget_unavailable" }] });
    expect(read).not.toHaveBeenCalled(); expect(ctx.budget.snapshot().attempts).toBe(10);
  });
  it("counts the child query but does not deliver its field when the recheck has no remaining attempt", async () => {
    const parentValue = parentRecord(), ctx = context();
    const wrapped = ctx.budget.wrap([{ name: "platformRecall", description: "budget fixture", parameters: {} as never, execute: () => ({}), formatResult: () => "{}" }])[0];
    for (let i = 0; i < 9; i++) await wrapped.execute({ i }, { toolCallId: String(i) });
    const read = vi.fn(async () => record({ title: "DO_NOT_PUBLISH" }, "chat", child));
    const result = await readPlatformRelatedChatTitle({ userId: identity.ownerId, parent: parentValue, parentContentHash: platformPublishedRecordHash(parentValue), context: ctx }, read);
    expect(result?.status).toBe("budget_unavailable"); expect(result?.fieldRead?.fields).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("DO_NOT_PUBLISH"); expect(read).toHaveBeenCalledOnce(); expect(ctx.budget.snapshot().attempts).toBe(10);
  });
  it("propagates cancellation before/during the child query instead of publishing a partial title", async () => {
    const parentValue = parentRecord(), ctx = context(), controller = new AbortController();
    const read = vi.fn(async () => { controller.abort(); return record({ title: "DO_NOT_PUBLISH" }, "chat", child); });
    await expect(readPlatformRelatedChatTitle({ userId: identity.ownerId, parent: parentValue, parentContentHash: platformPublishedRecordHash(parentValue), context: { ...ctx, signal: controller.signal } }, read)).rejects.toThrow();
    expect(read).toHaveBeenCalledOnce(); expect(ctx.budget.snapshot()).toMatchObject({ attempts: 1, inFlight: 0 });
    await expect(readPlatformRelatedChatTitle({ userId: identity.ownerId, parent: parentValue, parentContentHash: platformPublishedRecordHash(parentValue), context: { ...ctx, signal: controller.signal } }, read)).rejects.toThrow();
    expect(read).toHaveBeenCalledOnce();
  });
  it("honors a trusted explicit field denial without delivering its fetched title or continuing the relation read", async () => {
    const parentValue = parentRecord(), ctx = context(), authorize = vi.fn(async (binding: PlatformFieldReadBinding) => {
      expect(binding).toMatchObject({ ownerId: "owner", source: "chat", id: child, fieldKey: "title", turnId: identity.turnId }); return false;
    });
    const read = vi.fn(async () => record({ title: "DENIED_TITLE" }, "chat", child));
    const result = await readPlatformRelatedChatTitle({ userId: identity.ownerId, parent: parentValue, parentContentHash: platformPublishedRecordHash(parentValue), context: { ...ctx, authorize, authorizeSubject: async () => true } }, read);
    expect(result).toMatchObject({ status: "permission_denied", fieldRead: { fields: [], coverage: { fieldComplete: false } } });
    expect(JSON.stringify(result)).not.toContain("DENIED_TITLE"); expect(read).toHaveBeenCalledOnce(); expect(authorize).toHaveBeenCalledOnce(); expect(ctx.budget.snapshot().attempts).toBe(1);
  });
  it("does not let an adapter rejection guard override owner/hash checks, and fails closed if the turn closes during recheck", async () => {
    const parentValue = parentRecord(), ctx = context(), read = vi.fn(async (subject: { source: string; id: string }) => {
      if (subject.source === "chat") return record({ title: "DO_NOT_PUBLISH_AFTER_CLOSE" }, "chat", child);
      ctx.registry.close(); return parentValue;
    });
    const result = await readPlatformRelatedChatTitle({ userId: "owner", parent: parentValue, parentContentHash: platformPublishedRecordHash(parentValue), context: { ...ctx, verifyParentRelation: () => true } }, read);
    expect(result?.status).toBe("permission_denied"); expect(result?.fieldRead?.fields).toEqual([]); expect(JSON.stringify(result)).not.toContain("DO_NOT_PUBLISH_AFTER_CLOSE");
    expect(ctx.budget.snapshot().attempts).toBe(2);
    const fresh = context(), unused = vi.fn();
    expect((await readPlatformRelatedChatTitle({ userId: "other", parent: parentValue, parentContentHash: platformPublishedRecordHash(parentValue), context: { ...fresh, verifyParentRelation: () => true } }, unused))?.status).toBe("permission_denied");
    expect((await readPlatformRelatedChatTitle({ userId: "owner", parent: parentValue, parentContentHash: platformPublishedRecordHash(parentValue), context: { ...fresh, verifyParentRelation: () => false } }, unused))?.status).toBe("invalid_relation");
    expect(unused).not.toHaveBeenCalled();
  });
  it.each(["subject_denied", "version_callback_only"])("does not run a child body query when pre-query subject authority is %s", async vector => {
    const parentValue = parentRecord(), ctx = context(), read = vi.fn();
    const authorize = vi.fn(async () => false), authorizeSubject = vi.fn(async (subject: PlatformRelatedChatTitleSubject) => {
      expect(subject).toMatchObject({ ownerId: "owner", requester: identity.requester, turnId: identity.turnId, source: "chat", id: child, fieldKey: "title" });
      expect(subject).not.toHaveProperty("contentHash"); return false;
    });
    const result = await readPlatformRelatedChatTitle({ userId: "owner", parent: parentValue, parentContentHash: platformPublishedRecordHash(parentValue),
      context: { ...ctx, authorize, ...(vector === "subject_denied" ? { authorizeSubject } : {}) } }, read);
    expect(result).toMatchObject({ status: "permission_denied", fieldRead: { fields: [] },
      reads: [{ stage: "chat_title", queryAttempted: false, attemptCharged: true, status: "permission_denied" }] });
    expect(read).not.toHaveBeenCalled(); expect(authorize).not.toHaveBeenCalled(); expect(ctx.budget.snapshot().attempts).toBe(1);
    expect(result?.authorizationChecks).toEqual([vector === "subject_denied" ? "denied" : "subject_authorization_required"]);
    expect(authorizeSubject).toHaveBeenCalledTimes(vector === "subject_denied" ? 1 : 0);
  });
  it("checks genuine child version-bound permission only after subject permission, and denies a later revocation", async () => {
    const parentValue = parentRecord(), ctx = context(), childRecord = record({ title: "DENY_ON_LATE_SUBJECT_REVOCATION" }, "chat", child);
    const authorizeSubject = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const authorize = vi.fn(async (binding: PlatformFieldReadBinding) => {
      expect(binding.contentHash).toBe(platformPublishedRecordHash(childRecord));
      expect(binding.contentHash).not.toBe(platformPublishedRecordHash(parentValue)); return true;
    });
    const read = vi.fn(async (subject: { source: string; id: string }) => subject.source === "chat" ? childRecord : parentValue);
    const result = await readPlatformRelatedChatTitle({ userId: "owner", parent: parentValue, parentContentHash: platformPublishedRecordHash(parentValue), context: { ...ctx, authorize, authorizeSubject } }, read);
    expect(result?.status).toBe("permission_denied"); expect(result?.fieldRead?.fields).toEqual([]); expect(JSON.stringify(result)).not.toContain("DENY_ON_LATE_SUBJECT_REVOCATION");
    expect(authorizeSubject).toHaveBeenCalledTimes(2); expect(authorize).toHaveBeenCalledTimes(2); expect(ctx.budget.snapshot().attempts).toBe(2);
  });
});

describe("turn-scoped platform field handles", () => {
  it("uses opaque handles and rejects cross owner/requester/turn before reading", async () => {
    const { registry, handle, value } = prepare();
    expect(handle.readHandle).not.toContain(id);
    const lookup = vi.fn(async () => value);
    for (const wrong of [{ ...identity, ownerId: "other" }, { ...identity, turnId: "turn-b" }, { ...identity, requester: { kind: "chat" as const, id: "other" } }]) {
      await expect(readPlatformWholeField({ readHandle: handle.readHandle, registry, identity: wrong }, lookup)).rejects.toThrow("handle");
    }
    expect(lookup).not.toHaveBeenCalled();
  });
  it("expires and closes a registry without leaking its prior values", () => {
    let now = 1000;
    const registry = new PlatformReadHandleRegistry(identity, { now: () => now, ttlMs: 50 });
    const handle = registry.register({ source: "chat", id, fieldKey: "title", contentHash: "a".repeat(64) });
    now = 1051;
    expect(() => registry.resolve(handle.readHandle, identity)).toThrow("handle");
    registry.close();
    expect(() => registry.register({ source: "chat", id, fieldKey: "title", contentHash: "a".repeat(64) })).toThrow();
  });
  it("refuses arbitrary sources/fields and keeps a stable handle only for the same version", () => {
    const registry = new PlatformReadHandleRegistry(identity);
    for (const values of [{ source: "userLlmApiSettings", fieldKey: "apiKey" }, { source: "chat", fieldKey: "secret" }]) {
      expect(() => registry.register({ ...values, id, contentHash: "a".repeat(64) })).toThrow();
    }
    const a = registry.register({ source: "chat", id, fieldKey: "title", contentHash: "a".repeat(64) });
    expect(registry.register({ source: "chat", id, fieldKey: "title", contentHash: "a".repeat(64) })).toEqual(a);
    const b = registry.register({ source: "chat", id, fieldKey: "title", contentHash: "b".repeat(64) });
    expect(b.readHandle).not.toBe(a.readHandle);
  });
});

describe("whole-field bounded directed reads", () => {
  it.each(["startedAt", "completedAt"])("reads the exact stored %s field through its owner and version-bound handle", async fieldKey => {
    const literal = "2026-10-02T01:02:03.456789Z";
    const value = record({ [fieldKey]: literal, outputSummary: "unrelated result", verificationResult: "x".repeat(72000) });
    const registry = new PlatformReadHandleRegistry(identity);
    const decorated = attachPlatformReadHandlesToResult<PlatformPublishedFieldRecord & { readHandles?: PlatformReadHandle[] }>(value, registry);
    const handle = decorated.readHandles?.find(item => item.fieldKey === fieldKey);
    expect(handle).toBeDefined();
    const lookup = vi.fn(async (binding: PlatformFieldReadBinding) => {
      expect(binding).toMatchObject({ ...identity, source: "loopRuns", id, fieldKey, contentHash: platformPublishedRecordHash(value) });
      return value;
    });
    const result = await readPlatformWholeField({ readHandle: handle!.readHandle, registry, identity }, lookup);
    expect(result).toMatchObject({ status: "read", parentContentHash: platformPublishedRecordHash(value),
      fields: [{ fieldKey, value: literal, valueHash: digest(JSON.stringify(literal)), complete: true }],
      coverage: { fieldComplete: true, rawRecordComplete: false } });
    expect(result.fields).toHaveLength(1);
    expect(lookup).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain("unrelated result");
    expect(JSON.stringify(result)).not.toContain("x".repeat(200));
  });
  it("never decorates a record-shaped value inside published fields", () => {
    const embedded = { source: "chat", id: child, fields: { id: child, title: "quoted payload" } };
    const value = record({ outputSummary: embedded });
    const registry = new PlatformReadHandleRegistry(identity);
    const before = JSON.stringify(value.fields);
    const decorated = attachPlatformReadHandlesToResult(value, registry);
    expect(JSON.stringify(decorated.fields)).toBe(before);
    expect((decorated.fields.outputSummary as typeof embedded & { readHandles?: unknown }).readHandles).toBeUndefined();
    expect(platformPublishedRecordHash(decorated)).toBe(platformPublishedRecordHash(value));
  });
  it("reads a complete result without returning an unrelated large record or declaring its raw record read", async () => {
    const value = record({ outputSummary: "产物与未解决事项".repeat(200), verificationResult: "x".repeat(72000) });
    const { registry, handle } = prepare(value);
    const lookup = vi.fn(async (binding: PlatformFieldReadBinding) => { expect(binding.ownerId).toBe(identity.ownerId); return value; });
    const result = await readPlatformWholeField({ readHandle: handle.readHandle, registry, identity }, lookup);
    expect(result).toMatchObject({ schemaVersion: "platform-field-read.v1", status: "read", source: "loopRuns", id,
      parentContentHash: platformPublishedRecordHash(value), fields: [{ fieldKey: "outputSummary", value: value.fields.outputSummary,
        valueHash: digest(JSON.stringify(value.fields.outputSummary)), complete: true }], coverage: { fieldComplete: true, rawRecordComplete: false } });
    expect(JSON.stringify(result)).not.toContain("x".repeat(200));
  });
  it("uses the child chat's version, never the message parent version", async () => {
    const value = record({ title: "New Chat" }, "chat", child);
    const { registry, handle } = prepare(value, "title");
    const result = await readPlatformWholeField({ readHandle: handle.readHandle, registry, identity }, async () => value);
    expect(result).toMatchObject({ status: "read", id: child, parentContentHash: platformPublishedRecordHash(value), fields: [{ value: "New Chat" }] });
    expect(result.parentContentHash).not.toBe(platformPublishedRecordHash(record({ chatId: child }, "message")));
  });
  it("reports version changes before exposing values and returns an owner-visible lookup miss", async () => {
    const { registry, handle } = prepare();
    const changed = await readPlatformWholeField({ readHandle: handle.readHandle, registry, identity }, async () => record({ outputSummary: "changed" }));
    expect(changed).toMatchObject({ status: "version_changed", fields: [], coverage: { fieldComplete: false } });
    expect(JSON.stringify(changed)).not.toContain('"value":"changed"');
    const missing = await readPlatformWholeField({ readHandle: handle.readHandle, registry, identity }, async () => null);
    expect(missing).toMatchObject({ status: "not_found_in_scope", fields: [] });
    expect(missing.parentContentHash).toBeUndefined();
  });
  it("does not deliver a field when its turn registry closes or expires during the lookup", async () => {
    for (const change of ["closed", "expired"]) {
      let now = 1000;
      const registry = new PlatformReadHandleRegistry(identity, { now: () => now, ttlMs: 50 });
      const value = record({ outputSummary: "late private field" });
      const handle = registry.register({ source: value.source, id: value.id, fieldKey: "outputSummary", contentHash: platformPublishedRecordHash(value) });
      const result = await readPlatformWholeField({ registry, identity, readHandle: handle.readHandle }, async () => {
        if (change === "closed") registry.close(); else now = 1051;
        return value;
      });
      expect(result).toMatchObject({ status: "permission_denied", fields: [], coverage: { fieldComplete: false } });
      expect(JSON.stringify(result)).not.toContain("late private field");
    }
  });
  it("does not truncate escaped or emoji-heavy fields into apparently whole values", async () => {
    for (const text of ['"\\\n'.repeat(2000), "😀".repeat(4000)]) {
      const { registry, handle, value } = prepare(record({ outputSummary: text }));
      const result = await readPlatformWholeField({ readHandle: handle.readHandle, registry, identity }, async () => value);
      expect(result).toMatchObject({ status: "field_too_large", fields: [], fieldAvailability: { outputSummary: "present_unread" }, coverage: { fieldComplete: false } });
      expect(result.rawRead).toMatchObject({ source: "loopRuns", id, offset: 0, expectedHash: platformPublishedRecordHash(value) });
    }
  });
  it("preserves null/empty values and distinguishes unpublished fields", async () => {
    for (const item of [null, "", [], {}]) {
      const { registry, handle, value } = prepare(record({ outputSummary: item }));
      const result = await readPlatformWholeField({ readHandle: handle.readHandle, registry, identity }, async () => value);
      expect(result.status).toBe(item === null ? "not_recorded" : "read");
      expect(result.fields[0].value).toEqual(item);
    }
    const { registry, handle, value } = prepare(record({}));
    expect(await readPlatformWholeField({ readHandle: handle.readHandle, registry, identity }, async () => value)).toMatchObject({ status: "not_published", fields: [] });
  });
  it("rechecks authorization before the query, exposes errors as gaps, and rejects mismatched identities", async () => {
    const { registry, handle, value } = prepare();
    const lookup = vi.fn(async () => value);
    expect(await readPlatformWholeField({ readHandle: handle.readHandle, registry, identity, authorize: async () => false }, lookup)).toMatchObject({ status: "permission_denied", fields: [] });
    expect(lookup).not.toHaveBeenCalled();
    expect(await readPlatformWholeField({ readHandle: handle.readHandle, registry, identity }, async () => { throw Error("private database details"); })).toMatchObject({ status: "query_error", fields: [] });
    const mismatch = await readPlatformWholeField({ readHandle: handle.readHandle, registry, identity }, async () => record({ outputSummary: "foreign" }, "loopRuns", child));
    expect(mismatch).toMatchObject({ status: "query_error", fields: [] });
  });
  it("closes a revoked read after source completion without returning its field", async () => {
    const { registry, handle, value } = prepare();
    const authorize = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const result = await readPlatformWholeField({ readHandle: handle.readHandle, registry, identity, authorize }, async () => value);
    expect(result).toMatchObject({ status: "permission_denied", fields: [] });
    expect(result.parentContentHash).toBeUndefined();
  });
  it("supports the actual snake field representation without borrowing another representation's hash", async () => {
    const value = record({ output_summary: "saved result" }, "loop_runs");
    const { registry, handle } = prepare(value);
    const result = await readPlatformWholeField({ readHandle: handle.readHandle, registry, identity,
      observation: { kind: "frozen_capture", observedAt: "2026-10-02T00:00:00Z" } }, async () => value);
    expect(result).toMatchObject({ status: "read", source: "loop_runs", parentContentHash: platformPublishedRecordHash(value), observedAt: "2026-10-02T00:00:00Z", fields: [{ fieldKey: "outputSummary", value: "saved result" }] });
    const conflicting = record({ output_summary: "one", outputSummary: "other" }, "loop_runs");
    const conflict = prepare(conflicting);
    expect(await readPlatformWholeField({ readHandle: conflict.handle.readHandle, registry: conflict.registry, identity }, async () => conflicting)).toMatchObject({ status: "not_published", fields: [] });
  });
  it("returns whole known text parts while leaving tool payloads and unknown parts explicitly unread", async () => {
    const value = record({ parts: [{ type: "text", text: "original message" }, { type: "tool-result", output: "x".repeat(72000) }] }, "message");
    const { registry, handle } = prepare(value, "textParts");
    const result = await readPlatformWholeField({ readHandle: handle.readHandle, registry, identity }, async () => value);
    expect(result).toMatchObject({ status: "read", fields: [{ value: [{ index: 0, text: "original message" }], complete: true }], coverage: { rawRecordComplete: false } });
    expect(JSON.stringify(result)).not.toContain("x".repeat(200));
    const unknown = record({ parts: [{ type: "new-part", text: "not recognized" }] }, "message");
    const other = prepare(unknown, "textParts");
    expect(await readPlatformWholeField({ readHandle: other.handle.readHandle, registry: other.registry, identity }, async () => unknown)).toMatchObject({ status: "not_published", fields: [] });
    const missingText = record({ parts: [{ type: "text", text: null }] }, "message");
    const nullPart = prepare(missingText, "textParts");
    expect(await readPlatformWholeField({ readHandle: nullPart.handle.readHandle, registry: nullPart.registry, identity }, async () => missingText))
      .toMatchObject({ status: "not_published", fields: [], fieldAvailability: { textParts: "uninterpreted_parts" } });
  });
  it("keeps both original part indices and contiguous text indices in the authorized whole field", async () => {
    const value = record({ role: "assistant", parts: [{ type: "reasoning", text: "unread" },
      { type: "text", text: "first exact text" }, { type: "tool-result", output: "hidden result" },
      { type: "text", text: "second exact text" }] }, "message");
    const { registry, handle } = prepare(value, "textParts");
    const result = await readPlatformWholeField({ readHandle: handle.readHandle, registry, identity }, async () => value);
    expect(result).toMatchObject({ status: "read", fields: [{ value: [
      { index: 1, textIndex: 0, text: "first exact text" }, { index: 3, textIndex: 1, text: "second exact text" },
    ], complete: true }], coverage: { fieldComplete: true, rawRecordComplete: false } });
    expect(JSON.stringify(result)).not.toContain("hidden result");
  });
  it("decorates actual first-page/discovery receipts without changing raw bytes and skips continuations/errors", () => {
    const value = record({ outputSummary: "actual summary" });
    const registry = new PlatformReadHandleRegistry(identity);
    const raw = JSON.stringify(value), hash = platformPublishedRecordHash(value);
    const page = { source: "loopRuns", id, status: "read", offset: 0, contentHash: hash, content: raw, sourceHash: "capture" };
    const result = attachPlatformReadHandlesToResult({ recordRead: page, text: JSON.stringify(page) }, registry);
    expect(result.recordRead).toMatchObject({ content: raw, contentHash: hash, sourceHash: "capture", readHandles: expect.arrayContaining([expect.objectContaining({ fieldKey: "outputSummary" })]) });
    expect(JSON.parse(result.text).readHandles).toEqual((result.recordRead as any).readHandles);
    for (const changed of [{ ...page, offset: 8000 }, { ...page, status: "version_changed" }]) {
      expect(attachPlatformReadHandlesToResult(changed, registry)).not.toHaveProperty("readHandles");
    }
  });
});
