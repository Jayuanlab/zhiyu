import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyDocumentCleanerArtifactRun } from "@/lib/loops/document-artifact-verifier";
import { convertWorkshopDocumentToMarkdown } from "@/lib/workshops/document-markdown";

const roots: string[] = [];
const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const runDir = await mkdtemp(join(tmpdir(), "loop-document-verify-"));
  roots.push(runDir);
  await mkdir(join(runDir, "inputs"));
  const inputPath = join(runDir, "inputs", "source-1-guide.md");
  const text = "# Guide\n\nA real paragraph for later retrieval.\n";
  await writeFile(inputPath, text, "utf8");
  await writeFile(join(runDir, "inputs", "index.json"), JSON.stringify({
    staged: [{ sourceId: "source-1", runPath: inputPath, sha256: sha256(text) }],
    warnings: [],
  }), "utf8");
  const converted = await convertWorkshopDocumentToMarkdown({ runDir, inputPath, sourceId: "source-1", originalName: "guide.md" });
  const event = { metadata: {
    sourceId: "source-1", sourceSha256: converted.source.sha256,
    sourceFormat: converted.source.format,
    documentPath: converted.documentPath,
    documentSha256: sha256(await readFile(converted.documentPath)),
    manifestPath: converted.manifestPath,
    manifestSha256: sha256(await readFile(converted.manifestPath)),
    chunkCount: converted.chunkCount, chunks: converted.chunks,
  } };
  return { runDir, inputPath, converted, event };
}

describe("document cleaner Loop artifact verification", () => {
  it("accepts a conversion only when staging, receipt, manifest, and actual files agree", async () => {
    const { runDir, event } = await fixture();
    expect(await verifyDocumentCleanerArtifactRun({ runDir, events: [event] })).toEqual([]);
  });

  it("fails a tampered chunk and does not accept a missing or duplicate receipt", async () => {
    const { runDir, converted, event } = await fixture();
    await writeFile(converted.chunks[0].path, "changed after conversion", "utf8");
    const tampered = await verifyDocumentCleanerArtifactRun({ runDir, events: [event] });
    expect(tampered.some((issue) => issue.message.includes("chunk 0 path or SHA-256"))).toBe(true);
    const missing = await verifyDocumentCleanerArtifactRun({ runDir, events: [] });
    expect(missing.some((issue) => issue.message.includes("no document conversion event"))).toBe(true);
    const duplicate = await verifyDocumentCleanerArtifactRun({ runDir, events: [event, event] });
    expect(duplicate.some((issue) => issue.message.includes("duplicate document conversion events"))).toBe(true);
  });

  it("checks source, manifest, and document hashes against independent receipts", async () => {
    const { runDir, event } = await fixture();
    const incorrect = "0".repeat(64);
    const issues = await verifyDocumentCleanerArtifactRun({ runDir, events: [{ metadata: {
      ...event.metadata,
      sourceSha256: incorrect,
      manifestSha256: incorrect,
      documentSha256: incorrect,
    } }] });
    expect(issues.map((issue) => issue.message)).toEqual(expect.arrayContaining([
      expect.stringContaining("conversion event does not match staging"),
      expect.stringContaining("manifest SHA-256 is missing or incorrect"),
      expect.stringContaining("document SHA-256 is missing or incorrect"),
    ]));
  });

  it("rejects paths outside this run and unavailable staged sources", async () => {
    const { runDir, inputPath, event } = await fixture();
    const escaped = { metadata: { ...event.metadata, documentPath: inputPath } };
    const pathIssues = await verifyDocumentCleanerArtifactRun({ runDir, events: [escaped] });
    expect(pathIssues.some((issue) => issue.message.includes("escapes this run directory"))).toBe(true);
    const indexPath = join(runDir, "inputs", "index.json");
    const index = JSON.parse(await readFile(indexPath, "utf8"));
    index.warnings.push({ sourceId: "source-2", reason: "missing file" });
    await writeFile(indexPath, JSON.stringify(index), "utf8");
    const warningIssues = await verifyDocumentCleanerArtifactRun({ runDir, events: [event] });
    expect(warningIssues.some((issue) => issue.message.includes("source-2 was unavailable"))).toBe(true);
  });

  it("fails an empty staging index even without an agent receipt", async () => {
    const { runDir } = await fixture();
    await writeFile(join(runDir, "inputs", "index.json"), JSON.stringify({ staged: [], warnings: [] }), "utf8");
    const issues = await verifyDocumentCleanerArtifactRun({ runDir, events: [] });
    expect(issues.some((issue) => issue.message.includes("No file sources were staged"))).toBe(true);
  });
});
