import { describe, expect, it, vi } from "vitest";
import { Type } from "@earendil-works/pi-ai";
import { createMemoryAccessTool } from "@/lib/ai/memory-access";
import { createGuardedPiTool } from "@/lib/ai/runtime/pi-tool-adapter";
import { readPlatformSource } from "@/lib/ai/platform-source-reader";

const fake = (name: string, execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "source evidence" }], details: {} }))) => ({
  name, label: name, description: `${name} evidence`, parameters: Type.Object({}), execute,
});
const read = async (tool: ReturnType<typeof createMemoryAccessTool>, domains: string[], question = "question", extra = {}) => {
  const result = await tool.execute("call", { question, domains, ...extra }, undefined);
  return result.details as any;
};

describe("unified evidence access", () => {
  it("forwards only opaque platform field handles and refuses mixed identifiers/paging", async () => {
    const platform = fake("platformRecall");
    const tool = createMemoryAccessTool({ tools: [platform], identity: { kind: "chat" } });
    const handle = "pfr_" + "a".repeat(32);
    await read(tool, [], "all original question", { reads: [{ kind: "platform_field", readHandle: handle }] });
    expect(platform.execute).toHaveBeenCalledWith("call:platform:read-0", { readHandle: handle }, undefined);
    for (const extra of [{ id: "source" }, { offset: 0 }, { expectedHash: "a".repeat(64) }, { query: "narrow" }]) {
      await expect(read(tool, [], "q", { reads: [{ kind: "platform_field", readHandle: handle, ...extra }] })).rejects.toThrow();
    }
    expect(platform.execute).toHaveBeenCalledTimes(1);
  });
  it("keeps a delegated large field envelope withheld instead of sending a JSON prefix as a whole field", async () => {
    const platform = fake("platformRecall", vi.fn(async () => ({ content: [{ type: "text" as const, text: JSON.stringify({ fieldRead: { fields: ["x".repeat(13000)] } }) }], details: {} })));
    const tool = createMemoryAccessTool({ tools: [platform], identity: { kind: "chat" } });
    const result = await read(tool, [], "q", { reads: [{ kind: "platform_field", readHandle: "pfr_" + "a".repeat(32) }] });
    expect(result.observations[0]).toMatchObject({ truncated: true, evidence: "" });
    expect(result.coverage.gaps[0]).toMatchObject({ truncated: true });
  });
  it("bounds the actual escaped outer envelope and withdraws late-clipped field receipts", async () => {
    const text = JSON.stringify({ fieldRead: { fields: [{ value: "\\\"\n".repeat(1600), complete: true }] } });
    const platform = fake("platformRecall", vi.fn(async () => ({ content: [{ type: "text" as const, text }],
      details: { result: { fieldRead: { status: "read" } }, trace: { status: "completed" } } })));
    const tool = createMemoryAccessTool({ tools: [platform], identity: { kind: "chat" } });
    const result = await tool.execute("outer", { question: "all original requirements", domains: [], reads: [
      { kind: "platform_field", readHandle: "pfr_" + "a".repeat(32) },
      { kind: "platform_field", readHandle: "pfr_" + "b".repeat(32) },
    ] });
    const body = (result.content[0] as { text: string }).text;
    const details = result.details as any;
    expect(body.length).toBeLessThanOrEqual(24000);
    expect(JSON.parse(body).question).toBe("all original requirements");
    expect(details.observations.some((item: any) => item.truncated && item.evidence === "")).toBe(true);
    for (const [index, item] of details.observations.entries()) {
      expect(details.delegatedReceipts[index].deliveredComplete).toBe(item.evidence === text);
    }
    expect(details.coverage.gaps.some((item: any) => item.truncated)).toBe(true);
  });
  it("withholds an oversized original question whole rather than substituting a shorter one", async () => {
    const question = "\u0001".repeat(4000);
    const tool = createMemoryAccessTool({ tools: [], identity: { kind: "chat" } });
    const result = await tool.execute("outer", { question, domains: ["self"] });
    const body = (result.content[0] as { text: string }).text;
    expect(body.length).toBeLessThanOrEqual(24000);
    expect(JSON.parse(body)).toMatchObject({ status: "budget_exhausted", questionReadState: "withheld_whole_question" });
    expect(JSON.parse(body).question).toBeUndefined();
    expect((result.details as any).originalQuestion).toBe(question);
  });
  it("delivers selected source evidence without a same-scope broad lookup or manufactured gap", async () => {
    const calls: string[] = [];
    const source = fake("readPlatformSource", vi.fn(async () => { calls.push("source"); return { content: [{ type: "text" as const, text: "exact source" }], details: {} }; }));
    const platform = fake("platformRecall", vi.fn(async () => { calls.push("platform"); return { content: [{ type: "text" as const, text: "broad evidence".repeat(2000) }], details: {} }; }));
    const tool = createMemoryAccessTool({ tools: [source, platform], identity: { kind: "chat" } });
    const result = await read(tool, ["platform"], "question", { reads: [{ kind: "platform_source", id: "memory-policy" }] });
    expect(calls).toEqual(["source"]);
    expect(source.execute).toHaveBeenCalledExactlyOnceWith("call:platform:read-0", { sourceId: "memory-policy", startLine: 1 }, undefined);
    expect(platform.execute).not.toHaveBeenCalled();
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]).toMatchObject({ tool: "readPlatformSource", evidence: "exact source", truncated: false });
    expect(result.coverage.gaps).toEqual([]);
    expect(result.coverage.answerCompleteness).toBe("not_verified");
  });
  it("discovers implementation topics through the supplied source tool without routing private text externally", async () => {
    const source = fake("readPlatformSource");
    const web = fake("webSearch");
    const tool = createMemoryAccessTool({ tools: [source, web], identity: { kind: "chat" } });
    await read(tool, [], "private question", { reads: [{ kind: "platform_source_search", query: "长期成果目录", limit: 3 }] });
    expect(source.execute).toHaveBeenCalledWith("call:platform:read-0", { query: "长期成果目录", limit: 3 }, undefined);
    expect(web.execute).not.toHaveBeenCalled();
    await read(tool, [], "same topic wider", { reads: [{ kind: "platform_source_search", query: "长期成果目录", limit: 5 }] });
    expect(source.execute).toHaveBeenCalledTimes(2);
    expect((await read(tool, [], "repeat", { reads: [{ kind: "platform_source_search", query: "长期成果目录", limit: 5 }] })).observations[0].status).toBe("not_repeated");
  });
  it("rejects mixed search/expansion parameters before calling the source tool", async () => {
    const source = fake("readPlatformSource");
    const tool = createMemoryAccessTool({ tools: [source], identity: { kind: "chat" } });
    for (const override of [{ offset: 1 }, { id: "memory-policy" }, { expectedHash: "a".repeat(64) }, { cursor: "next" }, { limit: 13 }]) {
      await expect(read(tool, [], "search", { reads: [{ kind: "platform_source_search", query: "memory scope", ...override }] })).rejects.toThrow();
    }
    expect(source.execute).not.toHaveBeenCalled();
  });
  it("keeps search-source failures and partial catalog gaps visible in the unified result", async () => {
    const handler = vi.fn(async () => ({ content: [{ type: "text" as const, text: "source detail" }], details: { result: {
      status: "search", matches: [], gapStatus: "permission_denied", unavailable: [{ sourceId: "one", status: "permission_denied" }],
    } } }));
    const tool = createMemoryAccessTool({ tools: [fake("readPlatformSource", handler)], identity: { kind: "chat" } });
    const denied = await read(tool, [], "search", { reads: [{ kind: "platform_source_search", query: "missing" }] });
    expect(denied.observations[0].status).toBe("unavailable");
    expect(denied.coverage.observedDomains).toEqual([]);
    expect(denied.coverage.gaps[0].sourceGaps[0].status).toBe("permission_denied");
    handler.mockResolvedValueOnce({ content: [{ type: "text", text: "one valid match" }], details: { result: {
      status: "search", matches: [{ sourceId: "one" }] as any, gapStatus: null as any, unavailable: [{ sourceId: "other", status: "source_unavailable" }],
    } } });
    const partial = await read(tool, [], "search", { reads: [{ kind: "platform_source_search", query: "partial" }] });
    expect(partial.observations[0].status).toBe("retrieved");
    expect(partial.coverage.gaps[0].sourceGaps).toEqual([{ sourceId: "other", status: "source_unavailable" }]);
    expect(partial.coverage.answerCompleteness).toBe("not_verified");
  });
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
  it("forwards source continuation offset and hash without a default startLine", async () => {
    const source = fake("readPlatformSource");
    const tool = createMemoryAccessTool({ tools: [source], identity: { kind: "chat" } });
    const reads = [{ kind: "platform_source", id: "memory-policy", offset: 8000, expectedHash: "a".repeat(64) }];
    await read(tool, [], "continue source", { reads });
    expect(source.execute).toHaveBeenCalledWith("call:platform:read-0", { sourceId: "memory-policy", offset: 8000, expectedHash: "a".repeat(64) }, undefined);
    await read(tool, [], "first source page", { reads: [{ ...reads[0], offset: 0 }] });
    expect(source.execute).toHaveBeenLastCalledWith("call:platform:read-0", { sourceId: "memory-policy", offset: 0, expectedHash: "a".repeat(64) }, undefined);
    await expect(read(tool, [], "invalid source window", { reads: [{ ...reads[0], startLine: 2 }] })).rejects.toThrow("Invalid evidence read request");
    expect(source.execute).toHaveBeenCalledTimes(2);
  });
  it("preserves the actual guarded source receipt and treats version drift as unavailable", async () => {
    const source = createGuardedPiTool({
      name: "readPlatformSource", description: "Read published implementation source",
      parameters: Type.Object({ sourceId: Type.String(), offset: Type.Optional(Type.Integer({ minimum: 0 })), expectedHash: Type.Optional(Type.String()) }),
      policy: { allowedTools: ["readPlatformSource"], defaultDecision: "deny" },
      execute: params => readPlatformSource(params),
    });
    const tool = createMemoryAccessTool({ tools: [source], identity: { kind: "chat" } });
    const first = await read(tool, [], "read source", { reads: [{ kind: "platform_source", id: "memory-policy", offset: 0 }] });
    expect(first.observations[0].status).toBe("retrieved");
    expect(JSON.parse(first.observations[0].evidence)).toMatchObject({ status: "read", sourceId: "memory-policy", representation: "raw_source_text" });
    expect(first.delegatedReceipts[0]).toMatchObject({ toolName: "readPlatformSource", deliveredComplete: true, result: { status: "read", sourceId: "memory-policy" }, trace: { status: "completed" } });
    const changed = await read(tool, [], "continue source", { reads: [{ kind: "platform_source", id: "memory-policy", offset: 0, expectedHash: "0".repeat(64) }] });
    expect(changed.observations[0].status).toBe("unavailable");
    expect(changed.coverage.gaps[0]).toMatchObject({ status: "unavailable" });
    expect(changed.delegatedReceipts[0]).toMatchObject({ deliveredComplete: false, result: { status: "version_changed", content: "", nextRead: null } });
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
