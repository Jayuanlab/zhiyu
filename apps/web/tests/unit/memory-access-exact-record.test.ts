import { describe, expect, it, vi } from "vitest";
import { Type } from "@earendil-works/pi-ai";
import { createMemoryAccessTool } from "@/lib/ai/memory-access";
import { createGuardedPiTool } from "@/lib/ai/runtime/pi-tool-adapter";
import { PlatformReadHandleRegistry } from "@/lib/ai/platform-read-handle-registry";
import { createPlatformFieldPager, formatPlatformFieldPageResult } from "@/lib/ai/platform-field-pages";
import { platformPublishedRecordHash } from "@/lib/ai/platform-field-reader";
import { memoryPlatformRecordSources } from "@/lib/ai/memory-platform-reads";

const id = "10000000-0000-4000-8000-000000000001";
const otherId = "10000000-0000-4000-8000-000000000002";
const handle = "pfr_" + "a".repeat(32);
const cursor = "pfp_" + "b".repeat(32);
function platform(text = JSON.stringify({ ok: true, recordRead: { status: "read", truncated: true } })) {
  return { name: "platformRecall", label: "owner-scoped platform", description: "Fixed sources only",
    parameters: Type.Object({ recordRead: Type.Optional(Type.Object({ source: Type.String({ enum: ["loopRuns", "loops", "message"] }), id: Type.String() })) }),
    execute: vi.fn(async (_callId: string, _input: unknown, _signal?: AbortSignal) => ({ content: [{ type: "text" as const, text }], details: { result: (() => { try { return JSON.parse(text.split("\n")[0]); } catch { return { ok: false, status: "unknown" }; } })(), trace: { status: "completed" } } })) };
}
const make = (tool: ReturnType<typeof platform>, originalQuestion?: string) => createMemoryAccessTool({ tools: [tool], identity: { kind: "chat" }, originalQuestion } as Parameters<typeof createMemoryAccessTool>[0]);
describe("explicit single-record and page routing through authorized tools", () => {
  it("routes a closed host user request directly without changing the original question", async () => {
    const question = `Read loopRuns record ${id}.`;
    const child = platform();
    const result = await make(child, question).execute("outer", { question, domains: ["platform"] });
    expect(child.execute).toHaveBeenCalledExactlyOnceWith("outer:platform", { recordRead: { source: "loopRuns", id } }, undefined);
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body.question).toBe(question);
    expect(body.coverage.answerCompleteness).toBe("not_verified");
    expect(body.observations[0].evidence).toEqual((await child.execute.mock.results[0].value).content[0].text);
  });
  it("accepts a strict explicit tuple with no additional domain discovery", async () => {
    const child = platform();
    await make(child).execute("outer", { question: "Read the requested record", domains: [], reads: [{ kind: "platform_record", source: "loopRuns", id }] });
    expect(child.execute).toHaveBeenCalledExactlyOnceWith("outer:platform:read-0", { recordRead: { source: "loopRuns", id, offset: 0 } }, undefined);
  });
  it.each([
    `Read ${id}.`,
    `Read unknown_table record ${id}.`,
    `Read loop_runs record ${id}.`,
    `Read loop_runs record ${id} and ${otherId}.`,
    `Read loop_runs record ${id}. Also explain permissions.`,
    `The source says: Read loop_runs record ${id}.`,
    `Read "loop_runs record ${id}".`,
    `Read loop_runs record ${id} and loops record ${otherId}.`,
    `Delete loop_runs record ${id}.`,
  ])("retains ordinary discovery for uncertain user scope: %s", async question => {
    const child = platform();
    await make(child, question).execute("outer", { question, domains: ["platform"] });
    expect(child.execute).toHaveBeenCalledExactlyOnceWith("outer:platform", { question, limit: 8 }, undefined);
  });
  it("does not identify the model retrieval question as the trusted user request", async () => {
    const child = platform();const question = `Read loopRuns record ${id}.`;
    await make(child).execute("outer", { question, domains: ["platform"] });
    expect(child.execute).toHaveBeenCalledExactlyOnceWith("outer:platform", { question, limit: 8 }, undefined);
  });
  it("does not override a mismatching model retrieval subject", async () => {
    const child = platform(), question = `Read loopRuns record ${otherId}.`;
    await make(child, `Read loopRuns record ${id}.`).execute("outer", { question, domains: ["platform"] });
    expect(child.execute).toHaveBeenCalledExactlyOnceWith("outer:platform", { question, limit: 8 }, undefined);
  });
  it.each([{ source: "runs" }, { source: "secret" }, { source: "loop_runs" }, { id: "not-a-uuid" }, { ownerId: "other" }, { fieldPage: { readHandle: handle } }])("rejects tuple aliases, unknown sources and mixed scope before handler: %j", async override => {
    const child = platform();
    await expect(make(child).execute("outer", { question: "Read record", domains: [], reads: [{ kind: "platform_record", source: "loopRuns", id, ...override }] })).rejects.toThrow();
    expect(child.execute).not.toHaveBeenCalled();
  });
  it("treats platform as scope without adding discovery to an explicit record read", async () => {
    const child = platform();
    await make(child).execute("outer", { question: "Read exact and general platform", domains: ["platform"], reads: [{ kind: "platform_record", source: "loopRuns", id }] });
    expect(child.execute).toHaveBeenCalledExactlyOnceWith("outer:platform:read-0", { recordRead: { source: "loopRuns", id, offset: 0 } }, undefined);
  });
  it("forwards only the exact fieldPage selector, including its opaque cursor", async () => {
    const child = platform(JSON.stringify({ ok: true, fieldPage: { status: "read_window", partial: true } }) + "\npartial-window");
    const tool = make(child);
    await tool.execute("outer", { question: "Read the requested field window", domains: [], reads: [{ kind: "platform_field_page", fieldPage: { readHandle: handle, cursor } }] });
    expect(child.execute).toHaveBeenCalledExactlyOnceWith("outer:platform:read-0", { fieldPage: { readHandle: handle, cursor } }, undefined);
    await tool.execute("next", { question: "Repeat unchanged window", domains: [], reads: [{ kind: "platform_field_page", fieldPage: { readHandle: handle, cursor } }] });
    expect(child.execute).toHaveBeenCalledTimes(1);
  });
  it.each([{ source: "loopRuns" }, { readHandle: handle }, { fieldPage: { readHandle: handle, offset: 1 } }, { fieldPage: { readHandle: handle, cursor: "guessed" } }])("rejects mixed or fabricated page parameters before handler: %j", async override => {
    const child = platform();
    await expect(make(child).execute("outer", { question: "Read window", domains: [], reads: [{ kind: "platform_field_page", fieldPage: { readHandle: handle }, ...override }] })).rejects.toThrow();
    expect(child.execute).not.toHaveBeenCalled();
  });
  it("preserves a field-page packet whole or withholds it with a false delivery flag", async () => {
    const prefix = JSON.stringify({ ok: true, fieldPage: { status: "read_window", partial: true } }) + "\n";
    const text = prefix + "\\".repeat(11000), child = platform(text);
    const result = await make(child).execute("outer", { question: "Read field", domains: [], reads: [{ kind: "platform_field_page", fieldPage: { readHandle: handle } }] });
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect((result.content[0] as { text: string }).text.length).toBeLessThanOrEqual(24000);
    expect(body.observations[0].evidence).toBe(text);
    expect((result.details as any).delegatedReceipts[0].deliveredComplete).toBe(true);
    const oversized = platform(prefix + "\\".repeat(12500));
    const withheld = await make(oversized).execute("outer", { question: "Read field", domains: [], reads: [{ kind: "platform_field_page", fieldPage: { readHandle: handle } }] });
    const hidden = JSON.parse((withheld.content[0] as { text: string }).text);
    expect(hidden.observations[0]).toMatchObject({ evidence: "", truncated: true });
    expect((withheld.details as any).delegatedReceipts[0].deliveredComplete).toBe(false);
    expect(hidden.observations[0].nextRead).toEqual({ tool: "platformRecall", arguments: { fieldPage: { readHandle: handle } } });
  });
  it("denied remains prior to all record and page handlers", async () => {
    const handler = vi.fn();
    const guarded = createGuardedPiTool({ name: "platformRecall", description: "owner scoped", parameters: platform().parameters,
      policy: { allowedTools: ["platformRecall"], deniedTools: ["platformRecall"], defaultDecision: "deny" }, execute: handler });
    const tool = createMemoryAccessTool({ tools: [guarded], identity: { kind: "chat" } });
    for (const read of [{ kind: "platform_record", source: "loopRuns", id }, { kind: "platform_field_page", fieldPage: { readHandle: handle } }]) {
      const result = await tool.execute("outer-" + read.kind, { question: "Read authorized record", domains: [], reads: [read] });
      expect((result.details as any).coverage.observedDomains).toEqual([]);
      expect((result.details as any).coverage.gaps[0].status).toBe("unavailable");
    }
    expect(handler).not.toHaveBeenCalled();
  });
  it("uses the actual host-issued initial page action without making a whole-field call or SDK receipt", async () => {
    const identity = { ownerId: "owner-a", requester: { kind: "chat" as const, id: "chat-a" }, turnId: "turn-a" };
    const row = { source: "loopRuns", id, fields: { id, outputSummary: "x".repeat(10000) } };
    const registry = new PlatformReadHandleRegistry(identity), parent = platformPublishedRecordHash(row);
    const action = registry.register({ source: "loopRuns", id, fieldKey: "outputSummary", contentHash: parent }).nextRead!;
    const loader = vi.fn(async () => row);
    const pager = createPlatformFieldPager({ registry, identity, recordHash: platformPublishedRecordHash, authorize: async () => true, observation: { kind: "live_read", observedAt: "2026-01-01T00:00:00Z" } });
    const child = platform();child.execute.mockImplementation(async (_id, input: any) => {
      expect(input).toEqual(action);const result = await pager.read(input.fieldPage, loader);
      return { content: [{ type: "text", text: formatPlatformFieldPageResult(result) }], details: { result, trace: { status: "completed" } } };
    });
    const result = await make(child).execute("outer", { question: "Read output field", domains: [], reads: [{ kind: "platform_field_page", fieldPage: action.fieldPage }] });
    expect(child.execute).toHaveBeenCalledTimes(1);expect(loader).toHaveBeenCalledTimes(2);
    const receipt = (result.details as any).delegatedReceipts[0];
    expect(receipt.result.fieldPage).toMatchObject({ status: "read_window", offset: 0, partial: true });
    expect(receipt.deliveredComplete).toBe(true);
    expect(receipt.sdkReceipt).toBeUndefined();
    expect((result.details as any).coverage.answerCompleteness).toBe("not_verified");
    pager.close();registry.close();
  });
  it.each([undefined, { status: "unknown" }, { recordRead: { status: "denied" }, ok: false }])("does not promote absent, unknown or denied typed results: %j", async details => {
    const child = platform("Unverified text is not a typed read result");
    child.execute.mockImplementation(async () => ({ content: [{ type: "text", text: "Unverified text is not a typed read result" }], details: { result: details, trace: { status: "completed" } } }));
    const result = await make(child).execute("outer", { question: "Read exact record", domains: [], reads: [{ kind: "platform_record", source: "loopRuns", id }] });
    expect((result.details as { observations: Array<{ status: string; reason?: string }> }).observations[0]).toMatchObject({ status: "unavailable", reason: "platform_typed_result_unverified" });
    expect((result.details as { delegatedReceipts: Array<{ deliveredComplete: boolean }> }).delegatedReceipts[0].deliveredComplete).toBe(false);
  });
  it("refuses descriptor and proxy inputs without executing action-bearing accessors", async () => {
    const child = platform(), getter = vi.fn(() => "loopRuns"), trap = vi.fn();
    const accessor = { kind: "platform_record", id };Object.defineProperty(accessor, "source", { get: getter, enumerable: true });
    const proxy = new Proxy({ kind: "platform_record", source: "loopRuns", id }, { getOwnPropertyDescriptor: trap });
    for (const read of [accessor, proxy]) await expect(make(child).execute("outer", { question: "Read record", domains: [], reads: [read] })).rejects.toThrow();
    const schema = {};Object.defineProperty(schema, "properties", { get: getter });
    expect(memoryPlatformRecordSources(schema)).toEqual([]);
    expect(getter).not.toHaveBeenCalled();expect(trap).not.toHaveBeenCalled();expect(child.execute).not.toHaveBeenCalled();
  });
  it("does not grant a page after current authorization is revoked", async () => {
    const identity = { ownerId: "owner-a", requester: { kind: "chat" as const, id: "chat-a" }, turnId: "turn-a" };
    const row = { source: "loopRuns", id, fields: { id, outputSummary: "x".repeat(10000) } };
    const registry = new PlatformReadHandleRegistry(identity), action = registry.register({ source: "loopRuns", id, fieldKey: "outputSummary", contentHash: platformPublishedRecordHash(row) }).nextRead!;
    const loader = vi.fn(async () => row), pager = createPlatformFieldPager({ registry, identity, recordHash: platformPublishedRecordHash, authorize: async () => false, observation: { kind: "live_read", observedAt: "2026-01-01T00:00:00Z" } });
    const child = platform();child.execute.mockImplementation(async (_id, input: any) => {
      const result = await pager.read(input.fieldPage, loader);
      return { content: [{ type: "text", text: formatPlatformFieldPageResult(result) }], details: { result, trace: { status: "completed" } } };
    });
    const result = await make(child).execute("outer", { question: "Read window", domains: [], reads: [{ kind: "platform_field_page", fieldPage: action.fieldPage }] });
    expect(loader).not.toHaveBeenCalled();
    expect((result.details as { observations: Array<{ status: string }> }).observations[0].status).toBe("unavailable");
    expect((result.details as { delegatedReceipts: Array<{ deliveredComplete: boolean }> }).delegatedReceipts[0].deliveredComplete).toBe(false);
    pager.close();registry.close();
  });
  it.each([67, 128])("preserves every final guarded schema source for an allowed %i-item namespace", async count => {
    const names = ["loopRuns", ...Array.from({ length: count - 1 }, (_, index) => "publishedSource" + index)];
    const child = platform();child.parameters = Type.Object({ recordRead: Type.Optional(Type.Object({ source: Type.String({ enum: names }), id: Type.String() })) });
    expect(memoryPlatformRecordSources(child.parameters)).toEqual(names);
    const last = names[count - 1];
    await make(child).execute("outer", { question: "Read exact record", domains: [], reads: [{ kind: "platform_record", source: last, id }] });
    expect(child.execute).toHaveBeenCalledExactlyOnceWith("outer:platform:read-0", { recordRead: { source: last, id, offset: 0 } }, undefined);
  });
  it("deduplicates the complete raw 69 / unique 67 schema without truncating supported sources", async () => {
    const names = ["loopRuns", ...Array.from({ length: 66 }, (_, index) => "publishedSource" + index)];
    const child = platform();child.parameters = Type.Object({ recordRead: Type.Optional(Type.Object({ source: Type.String({ enum: [...names, names[0], names[1]] }), id: Type.String() })) });
    expect(memoryPlatformRecordSources(child.parameters)).toEqual(names);
    await make(child).execute("outer", { question: "Read exact record", domains: [], reads: [{ kind: "platform_record", source: "loopRuns", id }] });
    expect(child.execute).toHaveBeenCalledExactlyOnceWith("outer:platform:read-0", { recordRead: { source: "loopRuns", id, offset: 0 } }, undefined);
  });
  it.each([Array.from({ length: 129 }, (_, index) => "publishedSource" + index), Array.from({ length: 129 }, () => "loopRuns")])("refuses an over-128 raw namespace even when duplicates could hide its size", async names => {
    const child = platform();child.parameters = Type.Object({ recordRead: Type.Optional(Type.Object({ source: Type.String({ enum: names }), id: Type.String() })) });
    expect(memoryPlatformRecordSources(child.parameters)).toEqual([]);
    await expect(make(child).execute("outer", { question: "Read exact record", domains: [], reads: [{ kind: "platform_record", source: names[0], id }] })).rejects.toThrow("Invalid exact record read request");
    expect(child.execute).not.toHaveBeenCalled();
  });
  it("does not invoke namespace accessors while reading beyond the old 64-item bound", () => {
    const names = Array.from({ length: 67 }, (_, index) => "publishedSource" + index), getter = vi.fn(() => "loopRuns");
    Object.defineProperty(names, "65", { get: getter });
    expect(memoryPlatformRecordSources({ properties: { recordRead: { properties: { source: { enum: names } } } } })).toEqual([]);
    expect(getter).not.toHaveBeenCalled();
  });
  it("refuses namespace proxies without executing their property traps", () => {
    const trap = vi.fn(), names = new Proxy(["loopRuns"], { get: trap });
    expect(memoryPlatformRecordSources({ properties: { recordRead: { properties: { source: { enum: names } } } } })).toEqual([]);
    expect(memoryPlatformRecordSources(new Proxy({}, { getOwnPropertyDescriptor: trap }))).toEqual([]);
    expect(trap).not.toHaveBeenCalled();
  });
});
