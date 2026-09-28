import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { WorkshopSource } from "@/lib/db/schema";
import { createConversationFileSources } from "@/lib/workshops/conversation-input";
import {
  checkedRunPath,
  createPiLocalTools,
  stagePiWorkshopFileSources,
} from "@/lib/workshops/pi-local-tools";

describe("Pi Work local tools", () => {
  const roots: string[] = [];
  async function runDir() {
    const root = await mkdtemp(join(tmpdir(), "zhiyu-pi-local-"));
    roots.push(root);
    return root;
  }
  afterEach(async () => {
    for (const root of roots.splice(0)) {
      const target = resolve(root);
      if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith("zhiyu-pi-local-")) {
        throw new Error("Unexpected Pi test cleanup path");
      }
      await rm(target, { recursive: true, force: true });
    }
  });

  it("stages a source copy, reads it, and writes a separate result", async () => {
    const root = await runDir();
    const sourcePath = join(root, "original.csv");
    await writeFile(sourcePath, "id,value\n1,10\n1,10\n2,20\n", "utf8");
    const staged = await stagePiWorkshopFileSources(root, [{
      id: "source-1", type: "file", enabled: true, uri: sourcePath,
    } as unknown as WorkshopSource]);
    expect(staged.warnings).toEqual([]);
    expect(staged.staged).toHaveLength(1);
    const tools = createPiLocalTools(root);
    const read = tools.find(tool => tool.name === "Read")!;
    const result = await read.execute("read", { path: staged.staged[0].runPath });
    expect(JSON.stringify(result.content)).toContain("id,value");

    const write = tools.find(tool => tool.name === "Write")!;
    const outputPath = join(root, "outputs", "cleaned.csv");
    const written = await write.execute("write", { path: outputPath, content: "id,value\n1,10\n2,20\n" });
    expect(await readFile(outputPath, "utf8")).toBe("id,value\n1,10\n2,20\n");
    expect(written.details).toMatchObject({ artifactPath: outputPath, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(await readFile(sourcePath, "utf8")).toContain("1,10\n1,10");
    await expect(write.execute("overwrite", { path: staged.staged[0].runPath, content: "bad" }))
      .rejects.toThrow("read-only");
  });

  it("rejects paths outside the run directory", async () => {
    const root = await runDir();
    await expect(checkedRunPath(root, join(root, "..", "escape.txt"), true))
      .rejects.toThrow("outside");
  });

  it("does not stage an uploaded file whose bytes changed after registration", async () => {
    const root = await runDir();
    const sourcePath = join(root, "registered.txt");
    const originalHash = createHash("sha256").update("original").digest("hex");
    await writeFile(sourcePath, "changed", "utf8");
    const staged = await stagePiWorkshopFileSources(root, [{
      id: "source-changed", name: "registered.txt", type: "file", enabled: true, uri: sourcePath,
      config: { sha256: originalHash },
    } as unknown as WorkshopSource]);
    expect(staged.staged).toEqual([]);
    expect(staged.warnings).toEqual([{
      sourceId: "source-changed",
      reason: expect.stringContaining("changed since it was added"),
    }]);
  });

  it("reports enabled file sources with unsupported URIs instead of silently skipping them", async () => {
    const root = await runDir();
    const staged = await stagePiWorkshopFileSources(root, [{
      id: "remote-file", name: "remote.pdf", type: "file", enabled: true,
      uri: "https://example.invalid/remote.pdf",
    } as unknown as WorkshopSource]);
    expect(staged.staged).toEqual([]);
    expect(staged.warnings).toEqual([{
      sourceId: "remote-file",
      reason: expect.stringContaining("no supported local path"),
    }]);
  });

  it("records temporary input provenance and a visible failure without registering permanent sources", async () => {
    const root = await runDir();
    const sourcePath = join(root, "临时 报表.txt");
    const missingPath = join(root, "missing.txt");
    await writeFile(sourcePath, "一次性任务\n", "utf8");
    const sources = createConversationFileSources({ workshopId: "work", runId: "run", inputFiles: [sourcePath, missingPath] });
    const receipt = await stagePiWorkshopFileSources(root, sources);
    expect(receipt.staged).toHaveLength(1);
    expect(receipt.staged[0]).toMatchObject({ sourceId: sources[0].id, inputPath: sourcePath, scope: "conversation" });
    expect(receipt.warnings).toEqual([expect.objectContaining({ sourceId: sources[1].id, inputPath: missingPath, scope: "conversation" })]);
    expect(await readFile(receipt.staged[0].runPath, "utf8")).toBe("一次性任务\n");
  });

});
