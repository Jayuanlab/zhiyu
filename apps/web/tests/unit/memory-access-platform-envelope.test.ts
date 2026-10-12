import { describe, expect, it, vi } from "vitest";
import { Type } from "@earendil-works/pi-ai";
import { createMemoryAccessTool } from "@/lib/ai/memory-access";

function platform(text: string, failed = false) {
  return { name: "platformRecall", label: "platformRecall", description: "Owner checked evidence",
    parameters: Type.Object({}), execute: vi.fn(async () => ({ content: [{ type: "text" as const, text }],
      details: { result: { ok: !failed }, trace: { status: "completed" } } })) };
}
describe("structured platform evidence through the memory gateway", () => {
  it("keeps a valid nested platform packet whole when it fits the existing outer limit", async () => {
    const evidence = JSON.stringify({ recordRead: { content: "a".repeat(13500), truncated: true,
      publishedFacts: [{ field: "role", value: "assistant", complete: true }] },
      completionGate: { status: "record_read_continuation_required" } });
    const tool = createMemoryAccessTool({ tools: [platform(evidence)], identity: { kind: "chat" } });
    const result = await tool.execute("outer", { question: "Which record and role?", domains: ["platform"] });
    const body = (result.content[0] as { text: string }).text;
    const observation = JSON.parse(body).observations[0];
    expect(body.length).toBeLessThanOrEqual(24000);
    expect(observation).toMatchObject({ truncated: false, evidence });
    expect(observation.nextRead).toBeUndefined();
    expect(JSON.parse(observation.evidence).recordRead.publishedFacts[0].value).toBe("assistant");
    expect((result.details as any).delegatedReceipts[0]).toMatchObject({ deliveredComplete: true, modelText: evidence });
  });
  it("withholds an escaped platform packet whole if the outer envelope cannot contain it", async () => {
    const evidence = JSON.stringify({ content: "\"\\\n".repeat(2500), warning: "Partial source, not a complete answer" });
    expect(evidence.length).toBeLessThan(24000);
    const tool = createMemoryAccessTool({ tools: [platform(evidence)], identity: { kind: "chat" } });
    const result = await tool.execute("outer", { question: "What does this source say?", domains: ["platform"] });
    const body = (result.content[0] as { text: string }).text;
    const observation = JSON.parse(body).observations[0];
    expect(body.length).toBeLessThanOrEqual(24000);
    expect(observation).toMatchObject({ truncated: true, evidence: "", reason: "memory_access_output_over_budget" });
    expect(observation.nextRead).toEqual({ tool: "platformRecall", arguments: { question: "What does this source say?", limit: 8 } });
    expect((result.details as any).delegatedReceipts[0].deliveredComplete).toBe(false);
  });
  it("keeps a packet over the delegated budget explicitly unread with a direct read action", async () => {
    const evidence = JSON.stringify({ content: "a".repeat(25000) });
    const tool = createMemoryAccessTool({ tools: [platform(evidence)], identity: { kind: "chat" } });
    const result = await tool.execute("outer", { question: "Read owner evidence", domains: ["platform"] });
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body.observations[0]).toMatchObject({ truncated: true, evidence: "", reason: "platform_packet_withheld_whole" });
    expect(body.coverage.gaps).toContainEqual(expect.objectContaining({ truncated: true }));
    expect((result.details as any).delegatedReceipts[0].deliveredComplete).toBe(false);
  });
  it("does not grant a full delegated receipt or retry action to a failed packet", async () => {
    const evidence = JSON.stringify({ content: "a".repeat(14000), status: "permission_denied" });
    const execute = platform(evidence, true);
    const tool = createMemoryAccessTool({ tools: [execute], identity: { kind: "chat" } });
    const result = await tool.execute("outer", { question: "Read owner evidence", domains: ["platform"] });
    const observation = (result.details as any).observations[0];
    expect(observation.status).toBe("unavailable");
    expect(observation.nextRead).toBeUndefined();
    expect((result.details as any).delegatedReceipts[0].deliveredComplete).toBe(false);
    expect(execute.execute).toHaveBeenCalledTimes(1);
  });
});
