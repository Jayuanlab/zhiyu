import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkshopSource } from "@/lib/db/schema";
import {
  appendLoopPiDocumentSourcesToPrompt,
  prepareLoopPiDocumentSources,
  selectLoopFileSourceScope,
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
  it("loads all explicitly declared sources beyond twenty without including historical sources", () => {
    const sources=Array.from({length:24},(_,i)=>({name:`source-${i}`}));
    const names=selectLoopFileSourceScope({configuredTools:['Read'],allowedActions:['Read'],deniedActions:[],sources});
    expect(names).toHaveLength(24);
    expect(names).not.toContain('old-pinned-source');
  });
  it("does not broaden source loading when Read is denied or lacks either grant", () => {
    for(const [configuredTools,allowedActions,deniedActions] of [[['Read'],['Read'],['read']],[['Read'],[],[]],[[],['Read'],[]]]){
      expect(selectLoopFileSourceScope({configuredTools,allowedActions,deniedActions,sources:[{name:'source'}]})).toBeNull();
    }
  });
  it("bounds declared sources instead of silently dropping required inputs", () => {
    expect(()=>selectLoopFileSourceScope({configuredTools:['Read'],allowedActions:['Read'],deniedActions:[],sources:Array.from({length:1001},(_,i)=>({name:`source-${i}`}))})).toThrow('more than 1000');
  });
  it("stages read-only source copies without granting conversion", async () => {
    const {sessionDir, source, contents} = await fixture();
    const result = await prepareLoopPiDocumentSources({
      workshop: {modelConfig: {allowedTools: ["Read"]}}, runtimeEngine: "pi",
      allowedActions: ["Read"], sources: [source], sessionDir, maxToolCalls: 3,
    });
    expect(result.workDir).toBe(sessionDir);
    expect(result.convertDocuments).toBe(false);
    expect(await readFile(result.stagedFiles!.staged[0].runPath, "utf8")).toBe(contents);
    const prompt = appendLoopPiDocumentSourcesToPrompt("Research", result.stagedFiles, result.convertDocuments);
    expect(prompt).toContain(result.stagedFiles!.staged[0].runPath);
    expect(prompt).not.toContain("Call workshopConvertDocument");
  });

  it("does not expose file tools or stage sources without both Work and Loop grants", async () => {
    const {sessionDir, source} = await fixture();
    for (const [configured, allowed] of [[['Read'], []], [[], ['Read']]]) {
      const result = await prepareLoopPiDocumentSources({
        workshop: {modelConfig: {allowedTools: configured}}, runtimeEngine: "pi",
        allowedActions: allowed, sources: [source], sessionDir, maxToolCalls: 3,
      });
      expect(result.workDir).toBeUndefined();
      expect(result.stagedFiles).toBeNull();
    }
  });
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
