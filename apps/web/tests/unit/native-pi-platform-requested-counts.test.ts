import { afterEach, describe, expect, it, vi } from "vitest";
import { createNativePiWebChatToolDefinitions } from "@/lib/ai/native-pi-web-chat-tools";
import { createGuardedPiTool } from "@/lib/ai/runtime/pi-tool-adapter";

// Minimal immutable statistics capture from review80's real second desktop turn.
// Only the database read boundary is replaced; the native handler and serializer run.
const ownerId = "dcb1985e-3fe2-42fd-8978-7b04d1772850";
const originalQuestion = "查看记忆总体及各状态数量，请返回总数、active、candidate、rejected 的数量和数据来源。只查询。";
const observedAt = "2026-10-09T23:18:06.204Z";
const capturedMember = {
  source: "brainMemories.status", status: "ok", total: 1654,
  groups: [{ value: "deleted", count: 3 }, { value: "candidate", count: 960 },
    { value: "active", count: 516 }, { value: "verified", count: 171 }, { value: "weakened", count: 4 }],
  observedAt,
  scopeProof: {
    schemaVersion: "platform-statistics-scope-proof.v1", queryContractId: "owner-stored:brain_memories.status",
    queryContractVersion: "owner-stored-query.v1", universe: "owner_stored",
    authorizationRef: "5245013f4278069d34ddda4381e89fd4ddf5cbe380f0f099a4ab0af54de68975",
    source: "brain_memories.status", predicateHash: "1ba8263cce1159253469cb09e0c31370d6e06afbab1257d323f2beb2f07fdd19",
    queryHash: "cd76246a9ad7c9afac117c64d850b5ef5a6159646eb81246dd5094d1c42925f0",
    observation: { kind: "live", observedAt }, consistency: "single_query", populationCoverage: "complete_query",
    deliveryCoverage: "complete", adapter: "live_fixed_query",
    resultHash: "68047fd3f4dd21297ea928f10f35a63ccedba031dc6381d879beace7a3c8cf90",
    proofId: "124f3ad83210517eab8c2da522e605b06de52a28766aacbd19029029ab677163",
  },
};

function recallTool(members: unknown[] = [capturedMember], question = originalQuestion, userId = ownerId, visible?: unknown) {
  const payload = { ok: true, data: { statistics: { observedAt, results: structuredClone(members) } } };
  const read = vi.fn(async () => ({ ...payload, text: JSON.stringify(visible ?? payload) }));
  const args: Parameters<typeof createNativePiWebChatToolDefinitions> = [];
  args[0] = { userId, question, includeMemoryAccess: false,
    policy: { allowedTools: ["platformRecall"], defaultDecision: "deny" } };
  args[22] = read as never;
  const definition = createNativePiWebChatToolDefinitions(...args).find(tool => tool.name === "platformRecall")!;
  return { tool: createGuardedPiTool(definition), read };
}

afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });
describe("native agent statistics without an answer session", () => {
  it("delivers exact requested memory counts and proof-bound absent zero for the real original question", async () => {
    vi.stubEnv("PLATFORM_REASONING_MODE", "agent");
    vi.stubEnv("PLATFORM_ANSWER_MODE", "off");
    const { tool } = recallTool();
    const result = await tool.execute("memory-counts", { question: "查看记忆统计", sections: ["brain"] });
    const output = result.details.result as any;
    const expected = [
      { source: "brain_memories.status", requestedLabel: "active", value: "active", status: "supported", count: 516,
        proofId: capturedMember.scopeProof.proofId, observedAt, reason: "matching_source_dimension_value" },
      { source: "brain_memories.status", requestedLabel: "candidate", value: "candidate", status: "supported", count: 960,
        proofId: capturedMember.scopeProof.proofId, observedAt, reason: "matching_source_dimension_value" },
      { source: "brain_memories.status", requestedLabel: "rejected", value: "rejected", status: "supported", count: 0,
        proofId: capturedMember.scopeProof.proofId, observedAt, reason: "absent_dimension_value_in_complete_query" },
    ];
    expect(output.data.statistics.requestedCounts).toEqual(expected);
    const text = result.content.filter(part => part.type === "text").map(part => (part as { text: string }).text).join("\n");
    expect(JSON.parse(text).data.statistics.requestedCounts).toEqual(expected);
    expect(output.data.statistics.results).toEqual([capturedMember]);
    expect(output.data.statistics.results[0].total).toBe(1654);
  });
  it.each(["missing_proof", "missing_observed_at", "missing_proof_observed_at", "partial_delivery", "failed_member", "foreign_owner", "not_visible"])("keeps requested counts unknown for %s", async variant => {
    const member: any = structuredClone(capturedMember);
    if (variant === "missing_proof") delete member.scopeProof;
    if (variant === "missing_observed_at") delete member.observedAt;
    if (variant === "missing_proof_observed_at") delete member.scopeProof.observation.observedAt;
    if (variant === "partial_delivery") member.scopeProof.deliveryCoverage = "partial";
    if (variant === "failed_member") member.status = "unavailable";
    const { tool } = recallTool([member], originalQuestion, variant === "foreign_owner" ? "another-owner" : ownerId,
      variant === "not_visible" ? { ok: true, data: {} } : undefined);
    const result = await tool.execute("unsupported", { question: "查看记忆统计", sections: ["brain"] });
    const counts = (result.details.result as any).data.statistics.requestedCounts;
    expect(counts).toHaveLength(3);
    expect(counts.map((row: any) => [row.value, row.status, row.count, row.proofId, row.observedAt])).toEqual([
      ["active", "unknown", null, null, null], ["candidate", "unknown", null, null, null], ["rejected", "unknown", null, null, null],
    ]);
  });
  it.each(["记忆不是 rejected 数量是多少？", "记忆 'rejected' 数量是多少？", "记忆和车间 active 各有多少？"])("does not turn unsupported original syntax into a positive label request: %s", async question => {
    const { tool } = recallTool([capturedMember], question);
    const result = await tool.execute("negative", { question: "记忆 rejected、active 状态的数量", sections: ["brain"] });
    expect((result.details.result as any).data.statistics).not.toHaveProperty("requestedCounts");
  });
  it("does not transfer a complete memory proof into another explicitly requested population", async () => {
    const { tool } = recallTool([capturedMember], "车间 active 数量多少？记忆 candidate、rejected 数量多少？");
    const result = await tool.execute("populations", { question: "记忆统计", sections: ["brain"] });
    expect((result.details.result as any).data.statistics.requestedCounts.map((row: any) => [row.source, row.value, row.status, row.count])).toEqual([
      ["workshops.status", "active", "unknown", null], ["brain_memories.status", "candidate", "supported", 960],
      ["brain_memories.status", "rejected", "supported", 0],
    ]);
  });
  it("keeps the host owner and original question when tool arguments propose replacements", async () => {
    const { tool, read } = recallTool();
    const result = await tool.execute("replacement", { question: "记忆统计", sections: ["brain"],
      userId: "another-owner", originalQuestion: "车间 active 数量多少？" } as never);
    expect(read).toHaveBeenCalledWith(expect.objectContaining({ userId: ownerId, originalQuestion }));
    expect((result.details.result as any).data.statistics.requestedCounts.map((row: any) => row.source)).toEqual([
      "brain_memories.status", "brain_memories.status", "brain_memories.status",
    ]);
  });
  it("keeps requested historical counts unknown while retaining the actual current proof", async () => {
    const { tool } = recallTool([capturedMember], "截至2026-10-09T23:18:06.204Z，记忆 active、candidate、rejected 的数量是多少？");
    const result = await tool.execute("historical", { question: "当前记忆状态统计", sections: ["brain"] });
    const statistics = (result.details.result as any).data.statistics;
    expect(statistics.requestedCounts.map((row: any) => [row.value, row.status, row.count])).toEqual([
      ["active", "unknown", null], ["candidate", "unknown", null], ["rejected", "unknown", null],
    ]);
    expect(statistics.results).toEqual([capturedMember]);
  });
  it.each([
    ["2026-10-09T23:19:06.204Z", "supported", 0],
    ["2026-10-09T23:24:06.204Z", "unknown", null],
    ["2026-10-09T23:17:06.204Z", "unknown", null],
  ])("applies the existing current-state freshness boundary at %s", async (now, status, count) => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(now as string));
    const { tool } = recallTool([capturedMember], "当前记忆 rejected 的数量是多少？");
    const result = await tool.execute("freshness", { question: "记忆状态统计", sections: ["brain"] });
    expect((result.details.result as any).data.statistics.requestedCounts).toEqual([
      expect.objectContaining({ source: "brain_memories.status", value: "rejected", status, count }),
    ]);
  });
  it.each([
    "今天新增记忆 active、candidate、rejected 的数量是多少？",
    "本周记忆 active、candidate、rejected 的数量是多少？",
    "上周记忆 active、candidate、rejected 的数量是多少？",
    "过去7天记忆 active、candidate、rejected 的数量是多少？",
    "在随题提供的只读数据快照（2026-10-09T23:18:06.204Z）中，记忆 active、candidate、rejected 的数量是多少？",
  ])("does not present live counts as an unsupported temporal population: %s", async question => {
    const { tool } = recallTool([capturedMember], question);
    const result = await tool.execute("time-population", { question: "当前记忆状态统计", sections: ["brain"] });
    const statistics = (result.details.result as any).data.statistics;
    expect(statistics.requestedCounts.map((row: any) => [row.value, row.status, row.count])).toEqual([
      ["active", "unknown", null], ["candidate", "unknown", null], ["rejected", "unknown", null],
    ]);
    expect(statistics.results).toEqual([capturedMember]);
  });
});
