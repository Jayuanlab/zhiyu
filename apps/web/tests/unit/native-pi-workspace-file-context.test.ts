import { describe, expect, it, vi } from "vitest";
const reads = vi.hoisted(() => ({ readFile: vi.fn(), stat: vi.fn(), realpath: vi.fn() }));
vi.mock("node:fs", () => ({ promises: reads }));
import { buildNativePiWorkspaceFileRefsContext } from "@/lib/ai/native-pi-workspace-file-context";
describe("native Pi unregistered workspace files", () => {
  it.each(["notes.md", "../secret.txt", "C:\\private\\outside.txt"])("withholds %s without resolving or reading paths", async path => {
    const context = await buildNativePiWorkspaceFileRefsContext({ workDir: "not-an-owner-binding", refs: [{ path, name: "PRIVATE_NAME" }] });
    expect(context).toContain("memory_source_unregistered"); expect(context).not.toContain("PRIVATE_NAME");
    expect(context).toContain("does not grant Work access");
    for (const fn of Object.values(reads)) expect(fn).not.toHaveBeenCalled();
  });
  it("does not add a source assertion when no workspace files were requested", async () => {
    expect(await buildNativePiWorkspaceFileRefsContext({ workDir: "unused", refs: [] })).toBe("");
  });
});
