import { describe, expect, it } from "vitest";
import { readPlatformSource } from "@/lib/ai/platform-source-reader";
describe("published implementation reader", () => {
  it("lists only the fixed catalog and refuses paths or inherited object keys", async () => {
    expect((await readPlatformSource({})).status).toBe("catalog");
    for (const sourceId of ["../../.env.local", "__proto__", "constructor", "C:/Users/user/.env"]) await expect(readPlatformSource({ sourceId })).rejects.toThrow("catalog");
  });
  it("returns actual policy source with provenance and bounded pagination", async () => {
    const first = await readPlatformSource({ sourceId: "memory-policy" });
    expect(first).toMatchObject({ status: "read", sourcePath: "apps/web/lib/brain/policy.ts", startLine: 1, nextLine: 121 });
    expect(first.content).toContain("canReadMemory");
    expect(first.content).toContain("no_matching_grant");
    expect(first.contentHash).toMatch(/^[a-f0-9]{64}$/);
    const next = await readPlatformSource({ sourceId: "memory-policy", startLine: 121 });
    expect(next.contentHash).toBe(first.contentHash);
    expect(next.content).toMatch(/^121:/);
  });
});
