import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildNativePiWorkspaceFileRefsContext } from "@/lib/ai/native-pi-workspace-file-context";

describe("native Pi workspace file context", () => {
  it("loads selected text workspace files as read-only context", async () => {
    const workDir = await mkdtemp(path.join(os.tmpdir(), "pi-workspace-"));
    await writeFile(path.join(workDir, "notes.md"), "# Notes\nhello workspace");

    const context = await buildNativePiWorkspaceFileRefsContext({
      workDir,
      refs: [{ path: "notes.md", name: "notes.md" }],
    });

    expect(context).toContain("user-selected workspace files");
    expect(context).toContain("read-only text context");
    expect(context).toContain("does not grant file read, write, edit");
    expect(context).toContain("hello workspace");
  });

  it("rejects paths outside the workspace", async () => {
    const workDir = await mkdtemp(path.join(os.tmpdir(), "pi-workspace-"));
    const outsideFile = path.join(os.tmpdir(), `outside-${Date.now()}.md`);
    await writeFile(outsideFile, "secret");

    const context = await buildNativePiWorkspaceFileRefsContext({
      workDir,
      refs: [{ path: outsideFile, name: "outside.md" }],
    });

    expect(context).toContain("skipped because the path is outside the workspace");
    expect(context).not.toContain("secret");
  });

  it("skips binary workspace files", async () => {
    const workDir = await mkdtemp(path.join(os.tmpdir(), "pi-workspace-"));
    await writeFile(path.join(workDir, "report.pdf"), Buffer.from([0, 1, 2]));

    const context = await buildNativePiWorkspaceFileRefsContext({
      workDir,
      refs: [{ path: "report.pdf", name: "report.pdf" }],
    });

    expect(context).toContain("skipped because the content appears binary");
  });
});
