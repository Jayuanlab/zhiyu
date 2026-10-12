import { describe, expect, it, vi } from "vitest";
import { PlatformReadHandleRegistry } from "@/lib/ai/platform-read-handle-registry";
import { platformPublishedRecordHash } from "@/lib/ai/platform-field-reader";
import { createPlatformFieldPager, formatPlatformFieldPageResult, rejectPlatformFieldPageDelivery, type PlatformFieldPageResult } from "@/lib/ai/platform-field-pages";
import { createMemoryReadBudget } from "@/lib/ai/memory-read-budget";
import { readPlatformFieldPageForOwner, type PlatformRecordQuery } from "@/lib/ai/platform-record-reader";

vi.mock("@/lib/db/client", () => ({ db: new Proxy({}, { get() { throw Error("unit_real_db_denied"); } }) }));
vi.mock("@/lib/db/schema", () => ({}));

const identity = { ownerId: "synthetic-owner", requester: { kind: "chat" as const, id: "synthetic-chat" }, turnId: "synthetic-turn" };
const id = "11111111-1111-4111-8111-111111111111";
const fields = { id, status: "completed", outputSummary: "x".repeat(20000), verificationResult: { approved: false, detail: "v".repeat(20000) } };
const row = { source: "loopRuns", id, fields }, parent = platformPublishedRecordHash(row);
const observation = { kind: "frozen_capture" as const, observedAt: "2026-10-02T06:01:46.768Z" };
function fixture() {
  const registry = new PlatformReadHandleRegistry(identity), budget = createMemoryReadBudget();
  const handle = (fieldKey: string) => registry.register({ source: "loopRuns", id, fieldKey, contentHash: parent }).readHandle;
  const query = vi.fn<PlatformRecordQuery>(async ([source, , , projection], ids, userId) => {
    expect(source).toBe("loopRuns"); expect(userId).toBe(identity.ownerId); expect(ids).toEqual([id]);
    return [Object.fromEntries(projection.split(" ").filter(key => Object.hasOwn(fields, key)).map(key => [key, fields[key as keyof typeof fields]]))];
  });
  const read = async (readHandle: string, cursor?: string, authorize: () => Promise<boolean> = async () => true, adapter: PlatformRecordQuery = query) => {
    const params = { fieldPage: { readHandle, ...(cursor ? { cursor } : {}) } };
    const tool = budget.wrap([{ name: "platformRecall", description: "Explicit current-authority unit read", parameters: {},
      execute: async () => readPlatformFieldPageForOwner({ userId: identity.ownerId, identity, registry,
        fieldPage: params.fieldPage, authorize, observation }, adapter), formatResult: result => formatPlatformFieldPageResult(result as PlatformFieldPageResult) }])[0];
    return await tool.execute(params, { toolCallId: `unit-${budget.snapshot().attempts}` }) as PlatformFieldPageResult;
  };
  return { registry, budget, handle, query, read };
}
function continuation(result: Awaited<ReturnType<ReturnType<typeof fixture>["read"]>>) {
  expect(result.fieldPage.status).toBe("read_window");
  if (!("nextCursor" in result.fieldPage) || !result.fieldPage.nextCursor) throw Error("unit_continuation_required");
  return result.fieldPage.nextCursor;
}

describe("owner field page current authority", () => {
  it.each(["new-false", "new-throw", "new-nonboolean", "same-function-false", "same-function-throw"])("denies the independent counter %s before any current source query, then permits the same cursor to recover", async mode => {
    const f = fixture(), handle = f.handle("outputSummary"); let variable = true;
    const initial = vi.fn(async () => { if (mode === "same-function-throw" && !variable) throw Error("synthetic authority secret"); return variable; });
    const first = await f.read(handle, undefined, initial), cursor = continuation(first);
    expect(f.query).toHaveBeenCalledTimes(5); expect(initial).toHaveBeenCalledTimes(3);
    const current = mode.startsWith("same-function") ? initial : vi.fn(async () => {
      if (mode === "new-throw") throw Error("synthetic new authority secret");
      return (mode === "new-nonboolean" ? { allowed: false } : false) as unknown as boolean;
    });
    variable = false;
    const denied = await f.read(handle, cursor, current);
    expect(denied.fieldPage).toMatchObject({ status: "permission_denied", content: "" });
    expect(f.query).toHaveBeenCalledTimes(5); expect(current).toHaveBeenCalledTimes(mode.startsWith("same-function") ? 4 : 1);
    expect(JSON.stringify(denied)).not.toContain("secret");
    const recovered = await f.read(handle, cursor);
    expect(recovered.fieldPage).toMatchObject({ status: "read_window", offset: "end" in first.fieldPage ? first.fieldPage.end : -1 });
    expect(f.query).toHaveBeenCalledTimes(10); expect(f.budget.snapshot()).toMatchObject({ attempts: 3, inFlight: 0 });
    await expect(f.read(handle, cursor)).rejects.toThrow("memory_read_not_repeated");
    f.registry.close();
  });
  it.each([undefined, null, 0, 1, "false", "true", {}, [], { allowed: true }])("requires literal true from the replacement host callback: %j", async value => {
    const f = fixture(), handle = f.handle("outputSummary"), cursor = continuation(await f.read(handle));
    const current = vi.fn(async () => value as unknown as boolean), denied = await f.read(handle, cursor, current);
    expect(denied.fieldPage).toMatchObject({ status: "permission_denied", content: "" });
    expect(current).toHaveBeenCalledTimes(1); expect(f.query).toHaveBeenCalledTimes(5); f.registry.close();
  });
  it("uses the current query adapter for all three owner checks and both parent reads", async () => {
    const f = fixture(), handle = f.handle("outputSummary"), cursor = continuation(await f.read(handle));
    const next = vi.fn<PlatformRecordQuery>(f.query.getMockImplementation()!), authority = vi.fn(async () => true);
    const result = await f.read(handle, cursor, authority, next);
    expect(result.fieldPage.status).toBe("read_window"); expect(f.query).toHaveBeenCalledTimes(5);
    expect(next).toHaveBeenCalledTimes(5); expect(authority).toHaveBeenCalledTimes(3);
    expect(next.mock.calls.map(call => call[0][3])).toEqual(["id", expect.stringContaining("outputSummary verificationResult"), "id", expect.stringContaining("outputSummary verificationResult"), "id"]);
    f.registry.close();
  });
  it("honors an empty current owner adapter before reading parent content", async () => {
    const f = fixture(), handle = f.handle("outputSummary"), cursor = continuation(await f.read(handle));
    const next = vi.fn<PlatformRecordQuery>(async () => []), denied = await f.read(handle, cursor, async () => true, next);
    expect(denied.fieldPage).toMatchObject({ status: "permission_denied", content: "" });
    expect(next).toHaveBeenCalledTimes(1); expect(f.query).toHaveBeenCalledTimes(5);
    expect((await f.read(handle, cursor)).fieldPage.status).toBe("read_window"); f.registry.close();
  });
  it("keeps concurrent accepted and rejected calls' host callbacks separate", async () => {
    const f = fixture(), output = f.handle("outputSummary"), verification = f.handle("verificationResult");
    const outputCursor = continuation(await f.read(output)), verificationCursor = continuation(await f.read(verification));
    let release!: (value: boolean) => void, entered!: () => void;
    const wait = new Promise<boolean>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    const rejectAuthority = vi.fn(async () => { entered(); return wait; });
    const rejectQuery = vi.fn<PlatformRecordQuery>(async () => { throw Error("rejected_call_must_not_query"); });
    const rejectedRead = f.read(output, outputCursor, rejectAuthority, rejectQuery); await started;
    const acceptQuery = vi.fn<PlatformRecordQuery>(f.query.getMockImplementation()!), acceptAuthority = vi.fn(async () => true);
    const accepted = await f.read(verification, verificationCursor, acceptAuthority, acceptQuery);
    release(false); const rejected = await rejectedRead;
    expect(accepted.fieldPage.status).toBe("read_window"); expect(acceptAuthority).toHaveBeenCalledTimes(3); expect(acceptQuery).toHaveBeenCalledTimes(5);
    expect(rejected.fieldPage).toMatchObject({ status: "permission_denied", content: "" }); expect(rejectAuthority).toHaveBeenCalledTimes(1); expect(rejectQuery).not.toHaveBeenCalled();
    expect((await f.read(output, outputCursor)).fieldPage.status).toBe("read_window"); f.registry.close();
  });
  it("rechecks the same current callback after parent reads without advancing on revocation", async () => {
    const f = fixture(), handle = f.handle("outputSummary"), cursor = continuation(await f.read(handle));
    let calls = 0; const revoked = await f.read(handle, cursor, async () => ++calls < 2);
    expect(revoked.fieldPage).toMatchObject({ status: "permission_denied", content: "" }); expect(calls).toBe(2); expect(f.query).toHaveBeenCalledTimes(7);
    expect((await f.read(handle, cursor)).fieldPage.status).toBe("read_window"); f.registry.close();
  });
  it.each([false, "true", { allowed: true }])("cannot use a current allow callback to override the pager's permanent boundary: %j", async value => {
    const f = fixture(), handle = f.handle("outputSummary"), current = vi.fn(async () => true), read = vi.fn(async () => row);
    const pager = createPlatformFieldPager({ registry: f.registry, identity, recordHash: platformPublishedRecordHash,
      authorize: async () => value as boolean, observation });
    const result = await pager.read({ readHandle: handle }, read, undefined, current);
    expect(result.fieldPage).toMatchObject({ status: "permission_denied", content: "" }); expect(current).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled(); f.registry.close();
  });
  it("rejects a throwing permanent boundary and leaves the first read available", async () => {
    const f = fixture(), handle = f.handle("outputSummary"), current = vi.fn(async () => true); let deny = true;
    const pager = createPlatformFieldPager({ registry: f.registry, identity, recordHash: platformPublishedRecordHash,
      authorize: async () => { if (deny) throw Error("permanent secret"); return true; }, observation });
    const read = vi.fn(async () => row), denied = await pager.read({ readHandle: handle }, read, undefined, current);
    expect(denied.fieldPage).toMatchObject({ status: "permission_denied", content: "" }); expect(read).not.toHaveBeenCalled(); expect(current).not.toHaveBeenCalled();
    deny = false; const recovered = await pager.read({ readHandle: handle }, read, undefined, current);
    expect(recovered.fieldPage.status).toBe("read_window"); expect(read).toHaveBeenCalledTimes(2); expect(current).toHaveBeenCalledTimes(3);
    rejectPlatformFieldPageDelivery(recovered); f.registry.close();
  });
});
