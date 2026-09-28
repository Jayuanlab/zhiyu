import { describe, expect, it, vi } from "vitest";
import { Type } from "@earendil-works/pi-ai";
import { createSnapshotCatalogReader } from "@/lib/ai/snapshot-catalog-reader";
import { createGuardedPiTool } from "@/lib/ai/runtime/pi-tool-adapter";
const query = { userId: "u", workId: "w", view: "catalog" as const };
const success = () => ({ ok: true, text: '{"types":[]}', data: { types: [], coverage: { observedAt: "2026-01-01T00:00:00Z" } } });
describe("permission-local snapshot catalog reuse", () => {
  it("does not treat an invalid null filter as an omitted unrestricted filter", async () => {
    const source = vi.fn(async (input: any) => input.snapshotTypes === null ? { ok: false, text: "invalid filter", isError: true } : success());
    const read = createSnapshotCatalogReader(source);
    await read(query);
    expect((await read({ ...query, snapshotTypes: null })).ok).toBe(false);
    expect(source).toHaveBeenCalledTimes(2);
  });
  it("reuses only a matching query and preserves original observation time", async () => {
    let time = 1000;
    const source = vi.fn(async () => success());
    const read = createSnapshotCatalogReader(source, () => time);
    await read({ ...query, snapshotTypes: ["b", "a"] });
    time += 2000;
    const result = await read({ ...query, snapshotTypes: ["a", "b"] });
    expect(source).toHaveBeenCalledTimes(1);
    expect(result.data).toMatchObject({ coverage: { observedAt: "2026-01-01T00:00:00Z" }, readReuse: { reused: true, ageMs: 2000 } });
    await read({ ...query, workId: "other" });
    await read({ ...query, userId: "other" });
    await read({ ...query, recordedBefore: "2026-01-01T00:00:00Z" });
    expect(source).toHaveBeenCalledTimes(4);
  });
  it("expires reuse, honors refresh and never substitutes old success for failed refresh", async () => {
    let time = 0;
    const source = vi.fn(async () => success());
    const read = createSnapshotCatalogReader(source, () => time);
    await read(query);
    time = 30000;
    await read(query);
    expect(source).toHaveBeenCalledTimes(2);
    source.mockRejectedValueOnce(Error("offline"));
    await expect(read({ ...query, refresh: true })).rejects.toThrow("offline");
    await read(query);
    expect(source).toHaveBeenCalledTimes(4);
  });
  it("never reuses failed, oversized or exact-record results", async () => {
    const failed = vi.fn(async () => ({ ok: false, text: "offline", isError: true }));
    const readFailed = createSnapshotCatalogReader(failed);
    await readFailed(query); await readFailed(query);
    expect(failed).toHaveBeenCalledTimes(2);
    const source = vi.fn(async () => success());
    const read = createSnapshotCatalogReader(source);
    for (let i = 0; i < 2; i++) await read({ ...query, snapshotId: "id" });
    expect(source).toHaveBeenCalledTimes(2);
    const large = vi.fn(async () => ({ ...success(), text: "x".repeat(64001) }));
    const readLarge = createSnapshotCatalogReader(large);
    await readLarge(query); await readLarge(query);
    expect(large).toHaveBeenCalledTimes(2);
  });
  it("isolates instances and bounds retained queries", async () => {
    const source = vi.fn(async () => success());
    const first = createSnapshotCatalogReader(source);
    await first(query);
    await createSnapshotCatalogReader(source)(query);
    for (let i = 0; i < 8; i++) await first({ ...query, snapshotTypes: [`t${i}`] });
    await first(query);
    expect(source).toHaveBeenCalledTimes(11);
  });
  it("cannot reuse a cached observation after the outer tool is denied", async () => {
    const source = vi.fn(async () => success());
    const read = createSnapshotCatalogReader(source);
    const policy = { deniedTools: [] as string[] };
    const tool = createGuardedPiTool({ name: "brainListSnapshots", description: "read", parameters: Type.Object({}), policy,
      execute: () => read(query) });
    await tool.execute("first", {}, undefined);
    policy.deniedTools.push("brainListSnapshots");
    await expect(tool.execute("denied", {}, undefined)).rejects.toThrow();
    expect(source).toHaveBeenCalledTimes(1);
  });
});
