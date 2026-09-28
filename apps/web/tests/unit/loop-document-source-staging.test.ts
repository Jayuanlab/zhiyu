import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkshopSource } from "@/lib/db/schema";
import {
  appendLoopPiDocumentSourcesToPrompt,
  prepareLoopPiDocumentSources,
} from "@/lib/loops/native-executor";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "loop-document-sources-"));
  temporaryDirectories.push(root);
  const sourcePath = join(root, "source.txt");
  const sessionDir = join(root, "session");
  const contents = "A source document for the cleaner.\n";
  await writeFile(sourcePath, contents, "utf8");
  const source = {
    id: "source-1", type: "file", enabled: true, uri: sourcePath, name: "source.txt",
  } as WorkshopSource;
  return { root, sourcePath, sessionDir, contents, source };
}

describe("Pi Loop document source staging", () => {
  it("stages granted sources, exposes source IDs and hashes, and budgets one conversion call per source", async () => {
    const { sourcePath, sessionDir, contents, source } = await fixture();
    const result = await prepareLoopPiDocumentSources({
      workshop: { modelConfig: { allowedTools: ["workshopConvertDocument"] } },
      runtimeEngine: "pi",
      allowedActions: ["workshopConvertDocument"],
      sources: [source],
      sessionDir,
      maxToolCalls: 3,
    });

    const expectedHash = createHash("sha256").update(contents).digest("hex");
    expect(result.workDir).toBe(sessionDir);
    expect(result.maxToolCalls).toBe(6);
    expect(result.stagedFiles?.warnings).toEqual([]);
    expect(result.stagedFiles?.staged).toEqual([
      expect.objectContaining({ sourceId: source.id, sha256: expectedHash }),
    ]);
    expect(await readFile(result.stagedFiles!.staged[0].runPath, "utf8")).toBe(contents);

    const index = JSON.parse(await readFile(join(sessionDir, "inputs", "index.json"), "utf8"));
    expect(index.staged[0]).toMatchObject({ sourceId: source.id, sha256: expectedHash });
    const prompt = appendLoopPiDocumentSourcesToPrompt("Run this Loop.", result.stagedFiles);
    expect(prompt).toContain(`source-1 sha256=${expectedHash}`);
    expect(prompt).toContain("Call workshopConvertDocument with each staged sourceId");
    expect(prompt).not.toContain(sourcePath);
  });

  it("does not stage a source when the Loop has no conversion grant", async () => {
    const { sessionDir, source } = await fixture();
    const result = await prepareLoopPiDocumentSources({
      workshop: { modelConfig: { allowedTools: ["workshopConvertDocument"] } },
      runtimeEngine: "pi",
      allowedActions: [],
      sources: [source],
      sessionDir,
      maxToolCalls: 3,
    });

    expect(result.stagedFiles).toBeNull();
    expect(result.maxToolCalls).toBe(3);
    expect(appendLoopPiDocumentSourcesToPrompt("Run this Loop.", result.stagedFiles)).toBe("Run this Loop.");
    await expect(readFile(join(sessionDir, "inputs", "index.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
