import { describe, expect, it, vi } from "vitest";
import { Type } from "@earendil-works/pi-ai";
import { withMemoryReadBudget } from "@/lib/ai/memory-read-budget";
import { createGuardedPiTools } from "@/lib/ai/runtime/pi-tool-adapter";
import { createMemoryAccessTool } from "@/lib/ai/memory-access";

function definition(name = "brainListSnapshots", execute = vi.fn(async (_params: any) => "evidence")) {
  return { name, description: "read", parameters: Type.Any(), execute, formatResult: (r: unknown) => String(r) };
}
describe("shared memory read budget", () => {
  it("deduplicates reordered arguments but allows cursor/offset continuation and new instances", async () => {
    const def = definition();
    const [tool] = createGuardedPiTools(withMemoryReadBudget([def]));
    await tool.execute("a", { snapshotId: "s", offset: 0 });
    await expect(tool.execute("b", { offset: 0, snapshotId: "s" })).rejects.toThrow("memory_read_not_repeated");
    await tool.execute("c", { snapshotId: "s", offset: 8000 });
    await tool.execute("d", { view: "search", cursor: "next" });
    const [fresh] = createGuardedPiTools(withMemoryReadBudget([def]));
    await fresh.execute("e", { snapshotId: "s", offset: 0 });
    expect(def.execute).toHaveBeenCalledTimes(4);
  });
  it("checks deny before duplicate detection and preserves error traces", async () => {
    const policy = { allowedTools: ["brainListSnapshots"], deniedTools: [] as string[] };
    const trace = vi.fn();
    const def = definition();
    const [tool] = createGuardedPiTools(withMemoryReadBudget([{ ...def, policy, onTrace: trace }]));
    await tool.execute("a", {});
    policy.deniedTools.push("brainListSnapshots");
    await expect(tool.execute("b", {})).rejects.toThrow("denied");
    expect(def.execute).toHaveBeenCalledTimes(1);
    expect(trace.mock.calls.at(-1)?.[0]).toMatchObject({ status: "denied", metadata: { deniedBeforeHandler: true } });
  });
  it("withholds oversized payloads without leaking raw content and preserves room for exact reads", async () => {
    const big = definition("platformRecall", vi.fn(async () => "PRIVATE".repeat(4000)));
    const small = definition();
    const [broad, exact] = createGuardedPiTools(withMemoryReadBudget([big, small]));
    const error = await broad.execute("a", {}).catch(e => e);
    expect(error.message).toContain("memory_read_output_over_budget");
    expect(JSON.stringify(error.outcome)).not.toContain("PRIVATE");
    await expect(broad.execute("b", {})).rejects.toThrow("memory_read_not_repeated");
    await expect(exact.execute("c", { snapshotId: "s" })).resolves.toBeDefined();
  });
  it("caps concurrent aggregate output and blocks source execution after ten attempts", async () => {
    const def = definition("brainListSnapshots", vi.fn(async () => "x".repeat(23000)));
    const [tool] = createGuardedPiTools(withMemoryReadBudget([def]));
    const results = await Promise.allSettled([0, 1, 2].map(offset => tool.execute(String(offset), { offset })));
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(2);
    expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
    const fail = definition("webSearch", vi.fn(async () => { throw Error("offline"); }));
    const [retry] = createGuardedPiTools(withMemoryReadBudget([fail]));
    for (let i = 0; i < 10; i++) await expect(retry.execute(String(i), {})).rejects.toThrow("offline");
    await expect(retry.execute("limit", {})).rejects.toThrow("budget_exhausted");
    expect(fail.execute).toHaveBeenCalledTimes(10);
  });
  it("shares deduplication with askMemory and retains catalog reuse", async () => {
    const def = definition("platformRecall");
    const catalog = definition();
    const tools = createGuardedPiTools(withMemoryReadBudget([def, catalog]));
    const access = createMemoryAccessTool({ tools, identity: { kind: "chat" } });
    await access.execute("gateway", { question: "q", domains: ["platform"] });
    const args = def.execute.mock.calls[0][0];
    await expect(tools[0].execute("direct", args)).rejects.toThrow("memory_read_not_repeated");
    await tools[1].execute("catalog1", { view: "catalog" });
    await tools[1].execute("catalog2", { view: "catalog" });
    expect(catalog.execute).toHaveBeenCalledTimes(2);
  });
});
