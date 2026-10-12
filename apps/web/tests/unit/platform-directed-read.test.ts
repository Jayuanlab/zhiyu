import { describe, expect, it, vi } from "vitest";
import { PlatformReadHandleRegistry, type PlatformReadIdentity } from "@/lib/ai/platform-read-handle-registry";
import { platformPublishedRecordHash } from "@/lib/ai/platform-field-reader";
import { authorizePlatformPublishedRecordsForOwner, readPlatformFieldForOwner, readPlatformRecordForOwner } from "@/lib/ai/platform-record-reader";
import { recallPlatformInformationForUser } from "@/lib/ai/platform-recall";
import { createNativePiWebChatToolDefinitions } from "@/lib/ai/native-pi-web-chat-tools";
import { createGuardedPiTools } from "@/lib/ai/runtime/pi-tool-adapter";
import { createMemoryReadBudget } from "@/lib/ai/memory-read-budget";
import { createMemoryAccessTool } from "@/lib/ai/memory-access";

const id = "3c4be88b-947f-465d-9ce3-aff28891d274";
const chatId = "44861dfc-916f-431f-899b-364ca54f0aa1";
const identity: PlatformReadIdentity = { ownerId: "owner", requester: { kind: "chat", id: "owner-console" }, turnId: "one-turn" };
const run = { source: "loopRuns", id, fields: { id, outputSummary: "concrete artifact".repeat(220), triggerReason: "manual", verificationResult: { accepted: false } } };

function harness() {
  const registry = new PlatformReadHandleRegistry(identity);
  const query = vi.fn(async (source: readonly string[], ids: string[], owner: string) => {
    expect(owner).toBe(identity.ownerId);
    return source[0] === "loopRuns" && ids[0] === id ? [run.fields] : [];
  });
  const originalQuestion = `运行 ${id} 产出了什么，验证结果及触发原因是什么？`;
  const adapters = { inspectWork: vi.fn(), listLoops: vi.fn(), listArchitectureMemories: vi.fn(), listSnapshots: vi.fn(), listGrants: vi.fn(), listKnowledgeDocuments: vi.fn(), listToolCapabilities: vi.fn(),
    readRecords: vi.fn(async () => ({ requestedIds: [id], requestedNames: [], records: [run], failedSources: [], missingIds: [], freshness: "live_read", observedAt: new Date().toISOString(), instruction: "scope" })),
    readRecord: (input: Parameters<typeof readPlatformRecordForOwner>[0]) => readPlatformRecordForOwner(input, query),
    readField: (input: Parameters<typeof readPlatformFieldForOwner>[0]) => readPlatformFieldForOwner(input, query),
  };
  const recall = vi.fn((input: Parameters<typeof recallPlatformInformationForUser>[0]) => recallPlatformInformationForUser(input, adapters));
  const args: Parameters<typeof createNativePiWebChatToolDefinitions> = [];
  args[0] = { userId: "owner", turnId: identity.turnId, platformReadRegistry: registry, platformReadIdentity: identity, question: originalQuestion };
  args[22] = recall;
  const definitions = createNativePiWebChatToolDefinitions(...args).filter(tool => tool.name === "platformRecall");
  const budget = createMemoryReadBudget();
  const [tool] = createGuardedPiTools(budget.wrap(definitions));
  return { registry, query, recall, tool, budget, originalQuestion };
}

describe("real guarded platform directed reads", () => {
  it("retains all original requirements and reads one whole omitted field through the same turn and budget", async () => {
    const h = harness();
    const discovered = await h.tool.execute("discovery", { question: id, sections: ["registry"] });
    const raw = JSON.parse((discovered.content[0] as { text: string }).text);
    const handles = raw.data.records.records[0].readHandles;
    const field = await h.tool.execute("field", { readHandle: handles.find((handle: any) => handle.fieldKey === "outputSummary").readHandle });
    const answer = JSON.parse((field.content[0] as { text: string }).text);
    expect(answer.fieldRead).toMatchObject({ status: "read", source: "loopRuns", id, fields: [{ value: run.fields.outputSummary, complete: true }] });
    expect((field.details as any).result.answerRequirements).toEqual(expect.objectContaining({ originalQuestion: h.originalQuestion }));
    expect(h.budget.snapshot()).toMatchObject({ attempts: 2, inFlight: 0, maximumSingleCharacters: 24000, maximumTotalCharacters: 64000 });
    expect(h.query).toHaveBeenCalledExactlyOnceWith(expect.any(Array), [id], "owner");
  });
  it("rejects mixed handle branches in both schema and raw handler before any lookup", async () => {
    const h = harness();
    const handle = h.registry.register({ source: "loopRuns", id, fieldKey: "outputSummary", contentHash: platformPublishedRecordHash(run) }).readHandle;
    for (const extra of [{ question: "narrow" }, { recordRead: { source: "loopRuns", id } }, { offset: 0 }, { sections: [] }, { ownerId: "other" }]) {
      await expect(h.tool.execute("mixed", { readHandle: handle, ...extra })).rejects.toThrow();
    }
    expect(h.query).not.toHaveBeenCalled();
    expect(h.recall).not.toHaveBeenCalled();
  });
  it("shares a field handle with askMemory and never returns construction-only details as delivered evidence", async () => {
    const h = harness();
    const handle = h.registry.register({ source: "loopRuns", id, fieldKey: "outputSummary", contentHash: platformPublishedRecordHash(run) }).readHandle;
    const access = createMemoryAccessTool({ tools: [h.tool], identity: { kind: "chat" } });
    const delegated = await access.execute("outer", { question: "model shortened", domains: [], reads: [{ kind: "platform_field", readHandle: handle }] });
    const delivered = JSON.parse((delegated.content[0] as { text: string }).text);
    expect(delivered.observations[0]).toMatchObject({ tool: "platformRecall", truncated: false });
    expect(JSON.parse(delivered.observations[0].evidence).fieldRead.fields[0].value).toBe(run.fields.outputSummary);
    expect((delegated.details as any).delegatedReceipts[0]).toMatchObject({ deliveredComplete: true });
    expect(h.budget.snapshot().attempts).toBe(1);
    await expect(h.tool.execute("again", { readHandle: handle })).rejects.toThrow("memory_read_not_repeated");
    expect(h.budget.snapshot().attempts).toBe(1);
  });
  it("repeats native chat ownership and rejects duplicate rows and Work owner-console substitution", async () => {
    const registry = new PlatformReadHandleRegistry(identity);
    const record = { source: "chat", id: chatId, fields: { id: chatId, title: "New Chat" } };
    const readHandle = registry.register({ source: "chat", id: chatId, fieldKey: "title", contentHash: platformPublishedRecordHash(record) }).readHandle;
    const input = { userId: "owner", registry, identity, readHandle };
    const query = vi.fn(async () => [record.fields, record.fields]);
    expect(await readPlatformFieldForOwner(input, query)).toMatchObject({ status: "query_error", fields: [] });
    await expect(readPlatformFieldForOwner({ ...input, identity: { ...identity, requester: { kind: "work", id: "work-a" } } }, query)).rejects.toThrow("owner chat");
  });
  it("rechecks the parent and actual linked child with key-only owner predicates at final authorization", async () => {
    const subjects = [{ source: "message", id }, { source: "chat", id: chatId }];
    const query = vi.fn(async (source: readonly string[], ids: string[], owner: string) => {
      expect(owner).toBe("owner"); expect(source[3]).toBe(source[2]);
      return [{ [source[2]]: ids[0] }];
    });
    expect(await authorizePlatformPublishedRecordsForOwner({ userId: "owner", subjects }, query)).toMatchObject({ allowed: true, status: "allowed" });
    expect(query.mock.calls.map(call => call[0])).toEqual([["message", "chat", "id", "id"], ["chat", "owner", "id", "id"]]);
    query.mockImplementation(async source => source[0] === "chat" ? [] : [{ id }]);
    expect(await authorizePlatformPublishedRecordsForOwner({ userId: "owner", subjects }, query)).toMatchObject({ allowed: false, status: "not_found_in_scope" });
    query.mockRejectedValue(Error("unavailable"));
    expect(await authorizePlatformPublishedRecordsForOwner({ userId: "owner", subjects }, query)).toMatchObject({ allowed: false, status: "source_unavailable" });
  });
});
