import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { assertRagSourceProjection, ragSourceRecord } from "@/lib/memory/evidence/rag-record";
import { ragFixture, ragOwner } from "../fixtures/rag-source";
describe("owner RAG exact native versions and projection admission", () => {
  it("versions actual text and authority metadata even if legacy timestamps are unchanged", () => {
    const { document, record, chunk } = ragFixture("\u4e2d\u6587\u{1f600}");
    expect(record.revision).toMatch(/^ragdoc1:[a-f0-9]{64}$/);
    expect(ragSourceRecord({ ...document, blobPath: "different-private-locator" }, record.chunks).revision).not.toBe(record.revision);
    expect(ragSourceRecord(document, [{ ...chunk, content: "changed" }]).revision).not.toBe(record.revision);
  });
  it("keeps metadata-only source versions distinct and refuses body use under them", () => {
    const { document, record } = ragFixture(); const metadata = ragSourceRecord(document, [], true);
    expect(metadata.revision).toMatch(/^ragmeta1:/); expect(metadata.content).toBe("");
    expect(() => assertRagSourceProjection(metadata, { kind: "metadata", document: metadata.document })).not.toThrow();
    expect(() => assertRagSourceProjection(metadata, { kind: "document_window", start: 0, end: 1, content: "l", contentHash: "x" })).toThrow();
    expect(JSON.stringify(metadata.document)).not.toContain(document.blobPath); expect(JSON.stringify(metadata.document)).not.toContain(ragOwner);
    expect(metadata.revision).not.toBe(record.revision);
  });
  it("refuses missing, mixed-owner and out-of-order chunks", () => {
    const { document, chunk } = ragFixture();
    expect(() => ragSourceRecord(document, [])).toThrow();
    expect(() => ragSourceRecord(document, [{ ...chunk, userId: document.id }])).toThrow();
    expect(() => ragSourceRecord(document, [{ ...chunk, chunkIndex: 1 }])).toThrow();
  });
  it("checks the explicit source byte budget instead of silently loading a large legacy body", () => {
    const { document, chunk } = ragFixture();
    expect(() => ragSourceRecord(document, [{ ...chunk, content: "x".repeat(2 * 1024 * 1024 + 1) }])).toThrow();
  });
  it("requires a controlled original authority and binds its complete manifest ref to both native versions", () => {
    const { document, chunk } = ragFixture(), linked = { ...document, blobPath: `artifact:${document.id}` };
    expect(() => ragSourceRecord(linked, [chunk])).toThrow();
    const first = { kind: "managed_artifact" as const, ref: { record: { kind: "artifact" as const, id: document.id }, revision: "artifact-v1" }, objectBodyReread: false as const };
    const next = { ...first, ref: { ...first.ref, revision: "artifact-v2" } };
    expect(ragSourceRecord(linked, [chunk], false, first).revision).not.toBe(ragSourceRecord(linked, [chunk], false, next).revision);
    expect(ragSourceRecord(linked, [], true, first).revision).not.toBe(ragSourceRecord(linked, [], true, next).revision);
  });
  it("requires exact delivered windows, rejecting forged content, extra fields and arbitrary prefixes", () => {
    const { record, chunk } = ragFixture("0123456789"), contentHash = createHash("sha256").update(record.content).digest("hex");
    expect(() => assertRagSourceProjection(record, { kind: "document_window", start: 2, end: 5, content: "234", contentHash })).not.toThrow();
    for (const projection of [
      { kind: "document_window", start: 2, end: 5, content: "FAKE", contentHash },
      { kind: "document_window", start: 0, end: 10, content: "012", contentHash },
      { kind: "document_window", start: 2, end: 5, content: "234", contentHash, hiddenBody: "forged" },
      { kind: "chunks", documentName: record.document.fileName, chunks: [{ id: chunk.id, start: 0, end: 4, content: "012" }] },
    ]) expect(() => assertRagSourceProjection(record, projection)).toThrow();
    expect(() => assertRagSourceProjection(record, { kind: "chunks", documentName: record.document.fileName,
      chunks: [{ id: chunk.id, start: 0, end: 3, content: "012" }] })).not.toThrow();
  });
});
