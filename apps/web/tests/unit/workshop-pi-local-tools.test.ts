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

  it("withholds unbound source copies and reads while preserving a separately granted output write", async () => {
    const root = await runDir();
    const sourcePath = join(root, "original.csv");
    await writeFile(sourcePath, "id,value\n1,10\n1,10\n2,20\n", "utf8");
    const staged = await stagePiWorkshopFileSources(root, [{
      id: "source-1", type: "file", enabled: true, uri: sourcePath,
    } as unknown as WorkshopSource]);
    expect(staged.warnings).toEqual([expect.objectContaining({ sourceId: "source-1", reason: expect.stringContaining("memory_source_scope_unverified") })]);
    expect(staged.staged).toHaveLength(0);
    const tools = createPiLocalTools(root);
    const read = tools.find(tool => tool.name === "Read")!;
    const result = await read.execute("read", { path: sourcePath });
    expect(JSON.stringify(result.content)).toContain("memory_source_unregistered"); expect(JSON.stringify(result.content)).not.toContain("id,value");

    const write = tools.find(tool => tool.name === "Write")!;
    const outputPath = join(root, "outputs", "cleaned.csv");
    const written = await write.execute("write", { path: outputPath, content: "id,value\n1,10\n2,20\n" });
    expect(await readFile(outputPath, "utf8")).toBe("id,value\n1,10\n2,20\n");
    expect(written.details).toMatchObject({ artifactPath: outputPath, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(await readFile(sourcePath, "utf8")).toContain("1,10\n1,10");
    await expect(write.execute("overwrite", { path: join(root, "inputs", "source.txt"), content: "bad" }))
      .rejects.toThrow("read-only");
  });

  it("rejects paths outside the run directory", async () => {
    const root = await runDir();
    await expect(checkedRunPath(root, join(root, "..", "escape.txt"), true))
      .rejects.toThrow("outside");
  });

  it("does not treat an owner-provided digest as a formal Work source binding", async () => {
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
      reason: expect.stringContaining("memory_source_scope_unverified"),
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
      reason: expect.stringContaining("memory_source_scope_unverified"),
    }]);
  });

  it("withholds temporary conversation paths too, without copying their private body", async () => {
    const root = await runDir();
    const sourcePath = join(root, "临时 报表.txt");
    const missingPath = join(root, "missing.txt");
    await writeFile(sourcePath, "一次性任务\n", "utf8");
    const sources = createConversationFileSources({ workshopId: "work", runId: "run", inputFiles: [sourcePath, missingPath] });
    const receipt = await stagePiWorkshopFileSources(root, sources);
    expect(receipt.staged).toEqual([]); expect(receipt.warnings).toHaveLength(2);
    expect(receipt.warnings.every(row => row.reason.includes("memory_source_scope_unverified"))).toBe(true);
    expect(await readFile(join(root, "inputs", "index.json"), "utf8")).not.toContain("一次性任务");
  });
  it("does not let Edit expose or transform an unregistered existing file", async () => {
    const root = await runDir(), path = join(root, "private.txt"); await writeFile(path, "PRIVATE_BODY", "utf8");
    const edit = createPiLocalTools(root).find(tool => tool.name === "Edit")!;
    const result = await edit.execute("edit", { path, oldText: "PRIVATE", newText: "changed" });
    expect(JSON.stringify(result)).toContain("memory_source_unregistered"); expect(await readFile(path, "utf8")).toBe("PRIVATE_BODY");
  });

});
