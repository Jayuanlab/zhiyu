import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { saveUploadedArtifact, cleanupArtifact, activateArtifact } from "@/lib/memory/artifacts/service";
import { readOwnerRagSource } from "@/lib/memory/evidence/rag";
import { getKnowledgeBaseDocumentContentForUser, listKnowledgeBaseDocumentsForUser } from "@/lib/ai/knowledge-base-documents";
import { withMemoryDispatchContext, bindMemoryDispatchRuntime, assertMemoryDispatchCurrent } from "@/lib/memory/context/dispatch";

/** Only the caller's fresh isolated database and configured synthetic local objects are used. */
export async function checkMemoryModuleT6RagOrigin(client: postgres.Sql, owner: string) {
  const database = String((await client`SELECT current_database() AS name`)[0].name);
  assert.match(database, /^zhiyu_test_[a-f0-9]{32}$/);
  assert.equal(new URL(process.env.ZHIYU_TEST_DATABASE_URL ?? "").pathname, `/${database}`);
  const body = "T6_SYNTHETIC_RAG_ORIGIN \u4e2d\u6587\u{1f600}", foreign = randomUUID();
  await client`INSERT INTO "User"(id,email) VALUES (${foreign},${foreign + '@example.invalid'})`;
  async function seed(userId: string, blobPath: string) {
    const id = randomUUID(), chunkId = randomUUID();
    await client`INSERT INTO rag_documents(id,user_id,file_name,content_type,size_bytes,total_chunks,blob_path)
      VALUES (${id},${userId},'T6-origin.txt','text/plain',${Buffer.byteLength(body)},1,${blobPath})`;
    await client`INSERT INTO rag_chunks(id,document_id,user_id,chunk_index,content) VALUES (${chunkId},${id},${userId},0,${body})`;
    return { id, chunkId };
  }
  const artifact = await saveUploadedArtifact(owner, { commandId: randomUUID(), name: "T6-origin.txt", contentType: "text/plain", data: Buffer.from(body) });
  const managed = await seed(owner, `artifact:${artifact.manifest.id}`);
  await withMemoryDispatchContext(async () => {
    bindMemoryDispatchRuntime({ engine: "pi", adapter: "pi-agent-harness" });
    const metadata = await listKnowledgeBaseDocumentsForUser({ userId: owner, listSources: async () => ({
      records: [await readOwnerRagSource({ userId: owner, documentId: managed.id, metadataOnly: true })], hasMore: false }) });
    assert.equal(metadata.ok, true); if (!metadata.ok) throw Error("Managed RAG metadata unavailable");
    assert.equal(metadata.sourceUse.source, "rag-document-metadata");
    const text = await getKnowledgeBaseDocumentContentForUser({ userId: owner, documentId: managed.id, offset: 0 });
    assert.equal(text.ok, true); assert.ok(text.text.includes(body)); assert.ok(text.text.includes('"objectBodyReread":false'));
    await assertMemoryDispatchCurrent();
    await cleanupArtifact(owner, { kind: "artifact.cleanup", commandId: randomUUID(), artifactId: artifact.manifest.id, expectedRevision: artifact.manifest.revision });
    const blocked = await getKnowledgeBaseDocumentContentForUser({ userId: owner, documentId: managed.id, offset: 0 });
    assert.equal(blocked.ok, false); assert.ok(!blocked.text.includes(body)); assert.ok(blocked.text.includes("memory_source_origin_unavailable"));
    await assert.rejects(assertMemoryDispatchCurrent(), { code: "memory_dispatch_context_unavailable" });
  });
  assert.equal(Number((await client`SELECT count(*)::int AS n FROM rag_chunks WHERE document_id=${managed.id}`)[0].n), 1, "Origin revocation withholds parsed text without physically deleting an independent record");

  const active = await saveUploadedArtifact(owner, { commandId: randomUUID(), name: "T6-active-origin.txt", contentType: "text/plain", data: Buffer.from(body) });
  const foreignLink = await seed(foreign, `artifact:${active.manifest.id}`);
  const foreignRead = await getKnowledgeBaseDocumentContentForUser({ userId: foreign, documentId: foreignLink.id });
  assert.equal(foreignRead.ok, false); assert.ok(!foreignRead.text.includes(body));
  const versioned = await seed(owner, `artifact:${active.manifest.id}`);
  await withMemoryDispatchContext(async () => {
    bindMemoryDispatchRuntime({ engine: "pi", adapter: "pi-agent-harness" });
    const text = await getKnowledgeBaseDocumentContentForUser({ userId: owner, documentId: versioned.id }); assert.equal(text.ok, true);
    await assertMemoryDispatchCurrent();
    const rebound = await activateArtifact(owner, { kind: "artifact.activate", commandId: randomUUID(), artifactId: active.manifest.id,
      expectedRevision: active.manifest.revision, saveRecord: true });
    assert.notEqual(rebound.ref.revision, active.ref.revision);
    await assert.rejects(assertMemoryDispatchCurrent(), { code: "memory_dispatch_context_unavailable" });
    await cleanupArtifact(owner, { kind: "artifact.cleanup", commandId: randomUUID(), artifactId: rebound.manifest.id, expectedRevision: rebound.manifest.revision });
  });
  const legacy = await seed(owner, "https://legacy.invalid/public-object-not-revocable");
  await withMemoryDispatchContext(async () => {
    bindMemoryDispatchRuntime({ engine: "pi", adapter: "pi-agent-harness" });
    const text = await getKnowledgeBaseDocumentContentForUser({ userId: owner, documentId: legacy.id });
    assert.equal(text.ok, true); assert.ok(text.text.includes('"originalBinaryVerified":false')); assert.ok(text.text.includes("independent_saved_text"));
    assert.ok(!text.text.includes("https://legacy.invalid")); await assertMemoryDispatchCurrent();
    await client`UPDATE rag_chunks SET content=content||' CORRECTED' WHERE id=${legacy.chunkId} AND user_id=${owner}`;
    await assert.rejects(assertMemoryDispatchCurrent(), { code: "memory_dispatch_context_unavailable" });
  });
  return { name: "T6 RAG origin authority and representation identities", passed: true, checks: [
    "real metadata listing then bounded text read coexist without overwriting either proof",
    "same-owner active artifact manifest and full ref are part of native RAG source authority/version",
    "artifact cleanup blocks fresh parsed reads and later dispatch, retaining the RAG record itself",
    "a foreign artifact mapping never grants owner authority; active manifest ref changes invalidate old RAG use",
    "unmapped legacy parsed text is independent owner data, never a verified or retractable original binary",
    "correction of a legacy saved RAG chunk blocks the previous source proof before another dispatch",
  ] };
}
