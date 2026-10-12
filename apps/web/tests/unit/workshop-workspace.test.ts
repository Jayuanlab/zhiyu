import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { inspectWorkspace, prepareWorkspace, workspaceLayout, workspacePrompt } from "@/lib/workshops/workspace";
import { checkedRunPath } from "@/lib/workshops/pi-local-tools";

const roots: string[] = [];
async function root() {
  const path = await mkdtemp(join(tmpdir(), "zhiyu-workspace-"));
  roots.push(path);
  return path;
}
afterEach(async () => {
  for (const path of roots.splice(0)) {
    if (dirname(resolve(path)) !== resolve(tmpdir()) || !basename(path).startsWith("zhiyu-workspace-")) throw new Error("Unsafe cleanup path");
    await rm(path, { recursive: true, force: true });
  }
});

describe("persistent workshop/Loop workspace", () => {
  const scope = { userId: "owner", workshopId: "work-1", loopId: "loop-1" };
  it("shares the workshop identity, separates Loops/runs and preserves historical artifact paths", async () => {
    const app = await root();
    const oldRun = join(app, "sessions", "loops", "loop-1", "run-1");
    await mkdir(oldRun, { recursive: true });
    await writeFile(join(oldRun, "report.md"), "历史成果\n", "utf8");
    const first = await prepareWorkspace({ ...scope, runId: "run-1" }, app);
    const second = await prepareWorkspace({ ...scope, runId: "run-2" }, app);
    const other = await prepareWorkspace({ ...scope, loopId: "loop-2", runId: "run-3" }, app);
    expect(first.workshopDir).toBe(second.workshopDir);
    expect(first.workshopDir).toBe(other.workshopDir);
    expect(first.loopDir).not.toBe(other.loopDir);
    expect(first.runDir).not.toBe(second.runDir);
    expect(first.runDir).toBe(oldRun);
    expect(await readFile(join(oldRun, "report.md"), "utf8")).toBe("历史成果\n");
    const ref = JSON.parse(await readFile(join(first.loopDir!, "run-references", "run-1.json"), "utf8"));
    expect(ref).toMatchObject({ userId: "owner", workshopId: "work-1", loopId: "loop-1", runDir: oldRun });
    expect(await readdir(join(first.workshopDir!, "artifacts"))).toEqual([]);
    expect(first.stateAuthority).toBe("database");
    expect(workspacePrompt(first)).toContain("never automatically promote");
    await expect(checkedRunPath(oldRun, join(other.loopDir!, "private.txt"))).rejects.toThrow("outside");
    await expect(checkedRunPath(oldRun, "workspace-scope.json", true)).rejects.toThrow("read-only");
  });

  it("is idempotent under concurrent preparation without overwriting ownership or state", async () => {
    const app = await root();
    await Promise.all(Array.from({ length: 6 }, () => prepareWorkspace({ ...scope, runId: "same-run" }, app)));
    const layout = workspaceLayout(scope, app);
    expect(await readdir(join(layout.loopDir!, "run-references"))).toEqual(["same-run.json"]);
    expect((await inspectWorkspace(scope, app)).status).toBe("ready");
    await expect(prepareWorkspace({ ...scope, userId: "another-owner" }, app)).rejects.toThrow("ownership");
    expect((await inspectWorkspace({ ...scope, userId: "another-owner" }, app)).status).toBe("unavailable");
    expect(await readdir(layout.loopDir!)).not.toContain("state.json");
  });

  it("reports missing and corrupt storage explicitly and rejects traversal/reserved IDs", async () => {
    const app = await root();
    expect((await inspectWorkspace(scope, app)).status).toBe("not_created");
    for (const id of ["../escape", "a/b", "CON", "NUL", "", "a\\b"]) {
      expect(() => workspaceLayout({ ...scope, runId: id }, app)).toThrow("identifier");
    }
    const prepared = await prepareWorkspace(scope, app);
    await writeFile(join(prepared.loopDir!, "workspace.json"), "broken", "utf8");
    expect((await inspectWorkspace(scope, app)).status).toBe("unavailable");
    await expect(prepareWorkspace(scope, app)).rejects.toThrow();
    expect(await readFile(join(prepared.loopDir!, "workspace.json"), "utf8")).toBe("broken");
  });

  it("rejects directory junctions before writing outside the managed root", async () => {
    const app = await root();
    const outside = await root();
    await mkdir(join(app, "workspaces"));
    await symlink(outside, join(app, "workspaces", "workshops"), process.platform === "win32" ? "junction" : "dir");
    await expect(prepareWorkspace(scope, app)).rejects.toThrow("boundary");
    expect(await readdir(outside)).toEqual([]);
  });

  it("supports workshop-only runs and standalone Loops without fabricating a workshop", async () => {
    const app = await root();
    const work = await prepareWorkspace({ userId: "owner", workshopId: "work", runId: "work-run" }, app);
    expect(work.loopDir).toBeNull();
    expect(work.runDir).toBe(join(app, "sessions", "workshops", "work", "work-run"));
    const loop = await prepareWorkspace({ userId: "owner", loopId: "standalone", runId: "loop-run" }, app);
    expect(loop.workshopDir).toBeNull();
    expect(loop.loopDir).toBe(join(app, "workspaces", "loops", "standalone"));
  });
});
