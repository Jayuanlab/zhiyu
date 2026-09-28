import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { LoopVerificationIssue } from "./verifier";

type RecordValue = Record<string, unknown>;
type ConversionEvent = { metadata: unknown };

function record(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}

function inside(root: string, path: string): boolean {
  const child = relative(root, path);
  return Boolean(child) && child !== ".." && !child.startsWith("../") && !child.startsWith("..\\") && !isAbsolute(child);
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function digest(value: unknown): string {
  const hash = string(value);
  return /^[a-f0-9]{64}$/i.test(hash) ? hash.toLowerCase() : "";
}

async function fileHash(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
}

async function checkedFile(root: string, value: unknown): Promise<string> {
  const path = string(value);
  if (!path || !isAbsolute(path)) throw new Error("artifact path is missing or not absolute");
  const canonical = await realpath(path);
  if (!inside(root, canonical)) throw new Error("artifact path escapes this run directory");
  if (!(await stat(canonical)).isFile()) throw new Error("artifact path is not a file");
  return canonical;
}

function fileName(value: unknown): string {
  const name = string(value);
  return name && name === basename(name) && name !== "." && name !== ".." ? name : "";
}

/** Verify conversion receipts against the current run's staged inputs and real output files. */
export async function verifyDocumentCleanerArtifactRun(input: {
  runDir: string;
  events: readonly ConversionEvent[];
}): Promise<LoopVerificationIssue[]> {
  const issues: LoopVerificationIssue[] = [];
  let omittedIssues = 0;
  const fail = (message: string) => {
    if (issues.length < 100) issues.push({ code: "document_artifact_invalid", message, severity: "error" });
    else omittedIssues += 1;
  };
  if (!input.runDir) {
    fail("Document cleaner run directory is missing.");
    return issues;
  }

  let runDir: string;
  let inputsDir: string;
  let index: RecordValue;
  try {
    runDir = await realpath(input.runDir);
    inputsDir = await realpath(join(runDir, "inputs"));
    if (!inside(runDir, inputsDir)) throw new Error("inputs directory escapes this run");
    index = record(JSON.parse(await readFile(join(inputsDir, "index.json"), "utf8")));
  } catch (error) {
    fail(`Document cleaner run files cannot be verified: ${error instanceof Error ? error.message : String(error)}`);
    return issues;
  }

  const staged = Array.isArray(index.staged) ? index.staged : null;
  if (!staged) {
    fail("Staged source index has no source list.");
    return issues;
  }
  if (!Array.isArray(index.warnings)) fail("Staged source index has no warning list.");
  const warnings = Array.isArray(index.warnings) ? index.warnings : [];
  for (const warning of warnings) {
    const item = record(warning);
    fail(`File source ${string(item.sourceId) || "(unknown)"} was unavailable for staging: ${string(item.reason) || "unknown reason"}`);
  }
  if (staged.length === 0) fail("No file sources were staged for this document cleaner run.");
  if (staged.length > 1000) fail("Staged source count exceeds the 1000-source run limit.");
  let outputsDir: string;
  try {
    outputsDir = await realpath(join(runDir, "outputs"));
    if (!inside(runDir, outputsDir)) throw new Error("outputs directory escapes this run");
  } catch (error) {
    fail(`Document cleaner outputs cannot be verified: ${error instanceof Error ? error.message : String(error)}`);
    return issues;
  }
  const bySource = new Map<string, { sha256: string; runPath: string }>();
  for (const entry of staged) {
    const source = record(entry);
    const sourceId = string(source.sourceId);
    const sha256 = digest(source.sha256);
    if (!sourceId || !sha256 || !string(source.runPath)) {
      fail("Staged source index contains an incomplete source entry.");
      continue;
    }
    if (bySource.has(sourceId)) {
      fail(`Source ${sourceId} is duplicated in the staged source index.`);
      continue;
    }
    try {
      const runPath = await checkedFile(inputsDir, source.runPath);
      if (await fileHash(runPath) !== sha256) fail(`Staged source ${sourceId} SHA-256 does not match its file.`);
      bySource.set(sourceId, { sha256, runPath });
    } catch (error) {
      fail(`Staged source ${sourceId} cannot be verified: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const seen = new Set<string>();
  if (input.events.length > 1000) fail("More than 1000 document conversion events were recorded for this run.");
  for (const event of input.events) {
    const receipt = record(event.metadata);
    const sourceId = string(receipt.sourceId);
    if (!sourceId) {
      fail("A document conversion event has no sourceId.");
      continue;
    }
    if (seen.has(sourceId)) {
      fail(`Source ${sourceId} has duplicate document conversion events.`);
      continue;
    }
    seen.add(sourceId);
    const source = bySource.get(sourceId);
    if (!source) {
      fail(`Document conversion event for ${sourceId} has no staged source.`);
      continue;
    }
    if (digest(receipt.sourceSha256) !== source.sha256) {
      fail(`Source ${sourceId} SHA-256 in its conversion event does not match staging.`);
    }

    try {
      const manifestPath = await checkedFile(outputsDir, receipt.manifestPath);
      const documentPath = await checkedFile(outputsDir, receipt.documentPath);
      const manifestHash = await fileHash(manifestPath);
      const documentHash = await fileHash(documentPath);
      if (manifestHash !== digest(receipt.manifestSha256)) fail(`Source ${sourceId} manifest SHA-256 is missing or incorrect.`);
      if (documentHash !== digest(receipt.documentSha256)) fail(`Source ${sourceId} document SHA-256 is missing or incorrect.`);
      const manifest = record(JSON.parse(await readFile(manifestPath, "utf8")));
      const manifestSource = record(manifest.source);
      const manifestDocument = record(manifest.document);
      if (string(manifestSource.sourceId) !== sourceId || digest(manifestSource.sha256) !== source.sha256 ||
          string(manifestSource.format) !== string(receipt.sourceFormat) ||
          resolve(string(manifestSource.path)) !== source.runPath) {
        fail(`Source ${sourceId} manifest provenance does not match staging and the conversion event.`);
      }
      const declaredDocumentName = fileName(manifestDocument.fileName);
      if (!declaredDocumentName || resolve(dirname(manifestPath), declaredDocumentName) !== documentPath ||
          digest(manifestDocument.sha256) !== documentHash) {
        fail(`Source ${sourceId} document file does not match its manifest.`);
      }

      const eventChunks = Array.isArray(receipt.chunks) ? receipt.chunks : [];
      const manifestChunks = Array.isArray(manifest.chunks) ? manifest.chunks : [];
      const count = receipt.chunkCount;
      if (!Number.isSafeInteger(count) || (count as number) < 1 ||
          eventChunks.length !== count || manifestChunks.length !== count) {
        fail(`Source ${sourceId} chunk count does not match its receipt and manifest.`);
      }
      const seenIndexes = new Set<number>();
      for (let index = 0; index < eventChunks.length; index += 1) {
        const chunk = record(eventChunks[index]);
        const declared = record(manifestChunks[index]);
        const chunkIndex = chunk.index;
        if (!Number.isSafeInteger(chunkIndex) || chunkIndex !== index ||
            declared.index !== index || seenIndexes.has(chunkIndex as number)) {
          fail(`Source ${sourceId} chunk indexes are missing, duplicated, or out of order.`);
        }
        if (Number.isSafeInteger(chunkIndex)) seenIndexes.add(chunkIndex as number);
        const chunkPath = await checkedFile(outputsDir, chunk.path);
        const declaredName = fileName(declared.fileName);
        const actualHash = await fileHash(chunkPath);
        if (!declaredName || resolve(dirname(manifestPath), declaredName) !== chunkPath ||
            digest(chunk.sha256) !== actualHash || digest(declared.sha256) !== actualHash) {
          fail(`Source ${sourceId} chunk ${index} path or SHA-256 does not match its manifest and file.`);
        }
      }
    } catch (error) {
      fail(`Source ${sourceId} artifacts cannot be verified: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const sourceId of bySource.keys()) {
    if (!seen.has(sourceId)) fail(`Staged source ${sourceId} has no document conversion event.`);
  }
  if (omittedIssues) issues.push({ code: "document_artifact_invalid", message: `${omittedIssues} additional document artifact issues omitted.`, severity: "error" });
  return issues;
}
