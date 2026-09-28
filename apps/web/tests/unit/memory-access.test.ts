import { describe, expect, it, vi } from "vitest";
import { Type } from "@earendil-works/pi-ai";
import { createMemoryAccessTool } from "@/lib/ai/memory-access";
import { createGuardedPiTool } from "@/lib/ai/runtime/pi-tool-adapter";

const fake = (name: string, execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "source evidence" }], details: {} }))) => ({
  name, label: name, description: `${name} evidence`, parameters: Type.Object({}), execute,
});
const read = async (tool: ReturnType<typeof createMemoryAccessTool>, domains: string[], question = "question", extra = {}) => {
  const result = await tool.execute("call", { question, domains, ...extra }, undefined);
  return result.details as any;
};

describe("unified evidence access", () => {
  it("delegates content search through the authorized snapshot reader", async () => {
    const source = fake("brainListSnapshots");
    const tool = createMemoryAccessTool({ tools: [source], identity: { kind: "chat" } });
    await read(tool, [], "find evidence", { reads: [{ kind: "snapshot_search", query: "context window" }] });
    expect(source.execute).toHaveBeenCalledWith("call:platform:read-0", { view: "search", contentQuery: "context window", limit: 5 }, undefined);
    await read(tool, [], "continue evidence", { reads: [{ kind: "snapshot_search", query: "context window", cursor: "next-page" }] });
    expect(source.execute).toHaveBeenLastCalledWith("call:platform:read-0", { view: "search", contentQuery: "context window", limit: 5, cursor: "next-page" }, undefined);
  });
  it("reads an exact snapshot through the existing authorized snapshot tool", async () => {
    const source = fake("brainListSnapshots");
    const tool = createMemoryAccessTool({ tools: [source], identity: { kind: "chat" } });
    await read(tool, [], "historical evidence", { reads: [{ kind: "snapshot", id: "s", offset: 8000, expectedHash: "b".repeat(64) }] });
    expect(source.execute).toHaveBeenCalledWith("call:platform:read-0", { snapshotId: "s", offset: 8000, expectedHash: "b".repeat(64) }, undefined);
  });
  it("expands document windows through the supplied tool and preserves continuation", async () => {
    const source = fake("getFullDocumentContent");
    const tool = createMemoryAccessTool({ tools: [source], identity: { kind: "chat" } });
    const reads = [{ kind: "document", id: "d", offset: 8000, expectedHash: "a".repeat(64) }];
    const result = await read(tool, [], "expand", { reads });
    expect(source.execute).toHaveBeenCalledWith("call:knowledge:read-0", { documentId: "d", offset: 8000, expectedHash: "a".repeat(64) }, undefined);
    expect(result.coverage).toMatchObject({ requestedDomains: ["knowledge"], observedDomains: ["knowledge"], answerCompleteness: "not_verified" });
    expect((await read(tool, [], "different question", { reads })).observations[0].status).toBe("not_repeated");
  });
  it("expands published source IDs and reports missing document access without substituting sources", async () => {
    const source = fake("readPlatformSource");
    const tool = createMemoryAccessTool({ tools: [source], identity: { kind: "workshop" } });
    const result = await read(tool, [], "expand", { reads: [{ kind: "platform_source", id: "memory-policy", startLine: 121 }, { kind: "document", id: "d" }] });
    expect(source.execute).toHaveBeenCalledWith("call:platform:read-0", { sourceId: "memory-policy", startLine: 121 }, undefined);
    expect(result.coverage.gaps).toContainEqual(expect.objectContaining({ domain: "knowledge", status: "unavailable" }));
  });
  it("does not bypass a guarded document reader", async () => {
    const handler = vi.fn();
    const denied = createGuardedPiTool({ name: "getFullDocumentContent", description: "read", parameters: Type.Object({}), policy: { deniedTools: ["getFullDocumentContent"] }, execute: handler });
    const tool = createMemoryAccessTool({ tools: [denied], identity: { kind: "workshop" } });
    expect((await read(tool, [], "expand", { reads: [{ kind: "document", id: "d" }] })).coverage.gaps[0].status).toBe("unavailable");
    expect(handler).not.toHaveBeenCalled();
  });
  it("rejects malformed read requests before delegation", async () => {
    const source = fake("getFullDocumentContent");
    const tool = createMemoryAccessTool({ tools: [source], identity: { kind: "chat" } });
    await expect(read(tool, [], "expand", { reads: [{ kind: "document", id: "d", offset: -1 }] })).rejects.toThrow();
    expect(source.execute).not.toHaveBeenCalled();
  });
  it("reports only the supplied runtime identity and tools", async () => {
    const tool = createMemoryAccessTool({ tools: [fake("platformRecall")], identity: { kind: "workshop", id: "work-1" } });
    const result = await read(tool, ["self", "memory"]);
    expect(result.observations[0]).toMatchObject({ identity: { kind: "workshop", id: "work-1" }, availableTools: [{ name: "platformRecall" }, { name: "askMemory" }] });
    expect(result.observations[1]).toMatchObject({ status: "unavailable" });
  });
  it("cannot tunnel through a denied underlying tool", async () => {
    const handler = vi.fn();
    const denied = createGuardedPiTool({ name: "platformRecall", description: "read", parameters: Type.Object({}), policy: { deniedTools: ["platformRecall"] }, execute: handler });
    const tool = createMemoryAccessTool({ tools: [denied], identity: { kind: "chat" } });
    expect((await read(tool, ["platform"])).observations[0].status).toBe("unavailable");
    expect(handler).not.toHaveBeenCalled();
  });
  it("never forwards private question or memory into the external query", async () => {
    const web = fake("webSearch");
    const tool = createMemoryAccessTool({ tools: [web, fake("searchUnifiedMemory")], identity: { kind: "chat" } });
    const missing = await read(tool, ["memory", "external"], "private information");
    expect(missing.observations[1].status).toBe("needs_input");
    expect(web.execute).not.toHaveBeenCalled();
    await read(tool, ["external"], "private information", { publicQuery: "public documentation" });
    expect(web.execute).toHaveBeenCalledWith("call:external", { query: "public documentation", limit: 5 }, undefined);
  });
  it("retains successful evidence on partial failure and suppresses repeats", async () => {
    const bad = fake("platformRecall", vi.fn(async () => { throw Error("source offline"); }));
    const good = fake("searchKnowledgeBase");
    const tool = createMemoryAccessTool({ tools: [bad, good], identity: { kind: "chat" } });
    const first = await read(tool, ["platform", "knowledge"]);
    expect(first.observations.map((o: any) => o.status)).toEqual(["unavailable", "retrieved"]);
    expect((await read(tool, ["knowledge"])).observations[0].status).toBe("not_repeated");
    expect(good.execute).toHaveBeenCalledTimes(1);
  });
  it("bounds repeated distinct reads and respects cancellation", async () => {
    const source = fake("searchKnowledgeBase");
    const tool = createMemoryAccessTool({ tools: [source], identity: { kind: "chat" } });
    for (let i = 0; i < 8; i++) await read(tool, ["knowledge"], `q${i}`);
    expect((await read(tool, ["knowledge"], "q9")).observations[0].status).toBe("budget_exhausted");
    const abort = new AbortController(); abort.abort();
    await expect(tool.execute("cancelled", { question: "q", domains: ["self"] }, abort.signal)).rejects.toThrow();
    expect(source.execute).toHaveBeenCalledTimes(8);
  });
  it("labels clipping and handler failure instead of declaring an answer complete", async () => {
    const source = fake("platformRecall", vi.fn(async () => ({ content: [{ type: "text" as const, text: "a".repeat(50000) }], details: { result: { ok: false } } })));
    const tool = createMemoryAccessTool({ tools: [source], identity: { kind: "chat" } });
    const result = await read(tool, ["platform"]);
    expect(result.observations[0]).toMatchObject({ status: "unavailable", truncated: true, coverage: "bounded_retrieval_not_exhaustive" });
    expect(result.observations[0].evidence).toHaveLength(12000);
  });
});
