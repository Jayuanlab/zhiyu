import { describe, expect, it, vi } from "vitest";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createMemoryAccessTool } from "@/lib/ai/memory-access";

const id = "20000000-0000-4000-8000-000000000001";
const handle = "pfr_" + "a".repeat(32), cursor = "pfp_" + "b".repeat(32);
const cases = [
  { read: { kind: "document", id: "document-one" }, domain: "knowledge", tool: "getFullDocumentContent" },
  { read: { kind: "snapshot", id: "snapshot-one" }, domain: "platform", tool: "brainListSnapshots" },
  { read: { kind: "snapshot_search", query: "topic" }, domain: "platform", tool: "brainListSnapshots" },
  { read: { kind: "platform_source", id: "source-one" }, domain: "platform", tool: "readPlatformSource" },
  { read: { kind: "platform_source_search", query: "topic" }, domain: "platform", tool: "readPlatformSource" },
  { read: { kind: "platform_field", readHandle: handle }, domain: "platform", tool: "platformRecall" },
  { read: { kind: "platform_record", source: "loopRuns", id }, domain: "platform", tool: "platformRecall" },
  { read: { kind: "platform_field_page", fieldPage: { readHandle: handle, cursor } }, domain: "platform", tool: "platformRecall" },
] as const;
function child(name: string, text = "verified selected observation") {
  return { name, label: name, description: "Existing permission checked read", parameters: name === "platformRecall"
    ? Type.Object({ recordRead: Type.Optional(Type.Object({ source: Type.String({ enum: ["loopRuns"] }), id: Type.String() })) }) : Type.Object({}),
    execute: vi.fn(async () => ({ content: [{ type: "text" as const, text }], details: { result: (() => { try { return JSON.parse(text); } catch { return undefined; } })(), trace: { status: "completed" } } })) };
}
function tools() { return ["platformRecall", "getFullDocumentContent", "brainListSnapshots", "readPlatformSource", "searchKnowledgeBase", "searchUnifiedMemory", "webSearch"].map(name => child(name)); }
function text(result: Awaited<ReturnType<AgentTool["execute"]>>) { return JSON.parse(result.content.filter(b => b.type === "text").map(b => b.text).join("\n")); }

describe("domains select scope without duplicating explicit reads", () => {
  it.each(cases)("maps $read.kind to $domain and calls only $tool", async ({ read, domain, tool }) => {
    const available = tools(), access = createMemoryAccessTool({ tools: available, identity: { kind: "chat" } });
    const body = text(await access.execute("call", { question: "Read selected evidence", domains: [domain], reads: [read] }));
    expect(available.reduce((n, t) => n + t.execute.mock.calls.length, 0)).toBe(1);
    expect(available.find(t => t.name === tool)!.execute).toHaveBeenCalledTimes(1);
    expect(body.coverage.requestedDomains).toEqual([domain]);
    expect(body.coverage.answerCompleteness).toBe("not_verified");
    expect(body.question).toBe("Read selected evidence");
  });
  it.each(cases)("retains a separately selected memory scope beside $read.kind", async ({ read, domain, tool }) => {
    const available = tools(), access = createMemoryAccessTool({ tools: available, identity: { kind: "chat" } });
    const body = text(await access.execute("call", { question: "Read selected evidence and memory", domains: [domain, "memory"], reads: [read] }));
    expect(available.reduce((n, t) => n + t.execute.mock.calls.length, 0)).toBe(2);
    expect(available.find(t => t.name === tool)!.execute).toHaveBeenCalledTimes(1);
    expect(available.find(t => t.name === "searchUnifiedMemory")!.execute).toHaveBeenCalledExactlyOnceWith("call:memory", { query: "Read selected evidence and memory", limit: 8, sources: ["memory", "insights", "interactions", "graph"] }, undefined);
    expect(body.coverage.requestedDomains).toEqual([domain, "memory"]);
  });
  it.each(["platform", "knowledge", "memory"] as const)("keeps explicit broad %s retrieval when reads are absent", async domain => {
    const available = tools(), access = createMemoryAccessTool({ tools: available, identity: { kind: "chat" } });
    await access.execute("call", { question: "Discover evidence", domains: [domain] });
    expect(available.reduce((n, t) => n + t.execute.mock.calls.length, 0)).toBe(1);
    expect(available.find(t => t.name === ({ platform: "platformRecall", knowledge: "searchKnowledgeBase", memory: "searchUnifiedMemory" })[domain])!.execute).toHaveBeenCalledTimes(1);
  });
  it("keeps all explicit reads in one domain and a distinct broad knowledge read", async () => {
    const available = tools(), access = createMemoryAccessTool({ tools: available, identity: { kind: "chat" } });
    await access.execute("call", { question: "Read selected sources and knowledge", domains: ["platform", "knowledge"], reads: [cases[3].read, cases[7].read] });
    expect(available.find(t => t.name === "readPlatformSource")!.execute).toHaveBeenCalledTimes(1);
    expect(available.find(t => t.name === "platformRecall")!.execute).toHaveBeenCalledExactlyOnceWith("call:platform:read-1", { fieldPage: { readHandle: handle, cursor } }, undefined);
    expect(available.find(t => t.name === "searchKnowledgeBase")!.execute).toHaveBeenCalledTimes(1);
    expect(available.reduce((n, t) => n + t.execute.mock.calls.length, 0)).toBe(3);
  });
  it("maps document scope to knowledge, keeping a separately requested platform discovery", async () => {
    const available = tools(), access = createMemoryAccessTool({ tools: available, identity: { kind: "chat" } });
    await access.execute("call", { question: "Read document and discover platform", domains: ["knowledge", "platform"], reads: [cases[0].read] });
    expect(available.find(t => t.name === "getFullDocumentContent")!.execute).toHaveBeenCalledTimes(1);
    expect(available.find(t => t.name === "searchKnowledgeBase")!.execute).not.toHaveBeenCalled();
    expect(available.find(t => t.name === "platformRecall")!.execute).toHaveBeenCalledExactlyOnceWith("call:platform", { question: "Read document and discover platform", limit: 8 }, undefined);
  });
  it("does not replace an unavailable explicit handler with a broad same-domain handler", async () => {
    const platform = child("platformRecall"), access = createMemoryAccessTool({ tools: [platform], identity: { kind: "chat" } });
    const body = text(await access.execute("call", { question: "Read selected source", domains: ["platform"], reads: [cases[3].read] }));
    expect(platform.execute).not.toHaveBeenCalled();
    expect(body.observations).toHaveLength(1);
    expect(body.observations[0]).toMatchObject({ status: "unavailable", tool: "readPlatformSource" });
    expect(body.coverage.observedDomains).toEqual([]);
    expect(body.coverage.gaps).toHaveLength(1);
  });
  it.each(["denied", "source_unavailable"])("retains the explicit %s gap without a broad fallback", async status => {
    const selected = child("readPlatformSource", JSON.stringify({ ok: false, isError: true, status })), platform = child("platformRecall");
    const access = createMemoryAccessTool({ tools: [selected, platform], identity: { kind: "chat" } });
    const body = text(await access.execute("call", { question: "Read selected source", domains: ["platform"], reads: [cases[3].read] }));
    expect(selected.execute).toHaveBeenCalledTimes(1);expect(platform.execute).not.toHaveBeenCalled();
    expect(body.observations[0].status).toBe("unavailable");expect(body.coverage.observedDomains).toEqual([]);
    expect(body.coverage.gaps).toHaveLength(1);expect(body.coverage.answerCompleteness).toBe("not_verified");
  });
  it("keeps truncated selected evidence and its gap without a broad fallback", async () => {
    const selected = child("readPlatformSource", "x".repeat(30000)), platform = child("platformRecall");
    const access = createMemoryAccessTool({ tools: [selected, platform], identity: { kind: "chat" } });
    const body = text(await access.execute("call", { question: "Read selected source", domains: ["platform"], reads: [cases[3].read] }));
    expect(selected.execute).toHaveBeenCalledTimes(1);expect(platform.execute).not.toHaveBeenCalled();
    expect(body.coverage.gaps).toContainEqual(expect.objectContaining({ truncated: true, tool: "readPlatformSource" }));
    expect(body.coverage.answerCompleteness).toBe("not_verified");
  });
  it("repeated exact page is not repeated and cannot become a new broad lookup", async () => {
    const platform = child("platformRecall"), access = createMemoryAccessTool({ tools: [platform], identity: { kind: "chat" } });
    await access.execute("one", { question: "Read first window", domains: ["platform"], reads: [cases[7].read] });
    const body = text(await access.execute("two", { question: "A different retrieval question", domains: ["platform"], reads: [cases[7].read] }));
    expect(platform.execute).toHaveBeenCalledTimes(1);expect(body.observations[0].status).toBe("not_repeated");
    expect(body.coverage.observedDomains).toEqual([]);
  });
  it("retains the eight-call gateway limit without granting extra reads", async () => {
    const selected = child("readPlatformSource"), platform = child("platformRecall"), access = createMemoryAccessTool({ tools: [selected, platform], identity: { kind: "chat" } });
    let body;
    for (let n = 0; n < 9; n++) body = text(await access.execute("read" + n, { question: "Read selected source " + n, domains: ["platform"], reads: [{ kind: "platform_source", id: "source-" + n }] }));
    expect(selected.execute).toHaveBeenCalledTimes(8);expect(platform.execute).not.toHaveBeenCalled();
    expect(body.observations[0]).toMatchObject({ status: "budget_exhausted", reason: "report_remaining_gap" });
  });
  it("publishes the same scope meaning in the model description and domain schema", () => {
    const access = createMemoryAccessTool({ tools: tools(), identity: { kind: "chat" } });
    expect(access.description).toContain("domains select retrieval scope");
    expect(access.description).toContain("does not add a broad lookup");
    expect(access.description).toContain("document reads cover knowledge");
    expect(access.parameters.properties.domains.description).toContain("Explicit reads cover their mapped domain");
    expect(access.parameters.properties.domains.maxItems).toBe(5);
    expect(access.parameters.properties.reads.maxItems).toBe(4);
  });
});
