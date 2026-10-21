import { describe, expect, it, vi } from "vitest";
const reads = vi.hoisted(() => ({ readFile: vi.fn(), readdir: vi.fn(), stat: vi.fn(), access: vi.fn() }));
vi.mock("node:fs", () => ({ promises: reads }));
import { searchMemoryPathForUser } from "@/lib/ai/memory-path-search";
describe("unregistered legacy memory path", () => {
  it.each(["private-owner-root", "../secret", "https://legacy.invalid/object"])("refuses %s without traversing or probing a local directory", async memoryPath => {
    const result = await searchMemoryPathForUser({ query: "private", memoryPath, directory: ".." });
    expect(result).toMatchObject({ ok: false, isError: true, data: { code: "memory_source_unregistered", content: null } });
    expect(result.text).toContain("managed private artifact"); expect(result.text).not.toContain(memoryPath);
    for (const fn of Object.values(reads)) expect(fn).not.toHaveBeenCalled();
  });
});
