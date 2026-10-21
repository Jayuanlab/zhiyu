import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type postgres from "postgres";
import { createOwnerMemoryClient } from "@/lib/memory";
import { beginArtifact, uploadArtifactBytes, sealArtifact, activateArtifact, cleanupArtifact, readArtifact, readArtifactCurrent, saveUploadedArtifact } from "@/lib/memory/artifacts/service";
import { inspectOwnerArtifacts } from "@/lib/memory/artifacts/inspection";
import { MemoryModuleError } from "@/lib/memory/kernel/errors";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const rejected = (status: number) => (error: unknown) => error instanceof MemoryModuleError && error.status === status;
export async function checkMemoryModuleT5Artifacts(client: postgres.Sql, owner: string) {
  const other = randomUUID(); await client`INSERT INTO "User"(id,email) VALUES (${other},${other + '@example.invalid'})`;
  const bytes = new TextEncoder().encode("T5 固定原文 A😀中B\nimmutable artifact evidence\n"), name = "T5-中文原件.txt";
  const creator = createOwnerMemoryClient(owner), foreign = createOwnerMemoryClient(other);
  const beginCommand = { kind: "artifact.begin", commandId: randomUUID(), name, contentType: "text/plain", sizeBytes: bytes.byteLength, sha256: sha(bytes) };
  const begin = await creator.submit(beginCommand); assert.ok("manifest" in begin); if (!("manifest" in begin)) throw Error("Wrong artifact result");
  assert.equal(begin.manifest.state, "pending"); assert.equal(begin.manifest.name, name);
  const replayed = await creator.submit(beginCommand); assert.ok("manifest" in replayed); if (!("manifest" in replayed)) throw Error("Wrong replay result");
  assert.equal(replayed.manifest.id, begin.manifest.id); assert.equal(replayed.replayed, true);
  await assert.rejects(creator.submit({ ...beginCommand, name: name + "changed" }), rejected(409));
  await assert.rejects(creator.submit({ ...beginCommand, commandId: randomUUID(), ownerId: other }), rejected(400));
  assert.equal((await foreign.read({ purpose: "current", ref: { kind: "artifact", id: begin.manifest.id } })).status, "not_found");
  assert.equal((await readArtifact(owner, { artifactId: begin.manifest.id })).status, "unavailable");
  await uploadArtifactBytes(owner, { artifactId: begin.manifest.id, expectedRevision: begin.manifest.revision, data: bytes });
  const sealed = await sealArtifact(owner, { kind: "artifact.seal", commandId: randomUUID(), artifactId: begin.manifest.id, expectedRevision: begin.manifest.revision });
  const activeCommand = { kind: "artifact.activate", commandId: randomUUID(), artifactId: sealed.manifest.id, expectedRevision: sealed.manifest.revision, saveRecord: true };
  const active = await activateArtifact(owner, activeCommand); assert.equal(active.manifest.state, "active"); assert.ok(active.manifest.userFileId);
  const replayActive = await activateArtifact(owner, activeCommand); assert.equal(replayActive.replayed, true);
  assert.equal(Number((await client`SELECT used_bytes FROM user_file_usage WHERE user_id=${owner}`)[0].used_bytes), bytes.byteLength);
  assert.equal(Number((await client`SELECT count(*)::int AS n FROM user_files WHERE id=${active.manifest.userFileId}`)[0].n), 1);
  const evidence = await creator.read({ purpose: "evidence", ref: active.ref, range: { start: 0, end: bytes.byteLength } });
  assert.equal(evidence.status, "ok"); assert.ok("encoding" in evidence); if (!("encoding" in evidence)) throw Error("Expected encoded artifact evidence");
  assert.equal(evidence.encoding, "base64"); assert.deepEqual(new Uint8Array(Buffer.from(evidence.content, "base64")), bytes);
  assert.equal(evidence.receipt.purpose, "evidence"); assert.deepEqual(evidence.receipt.actualRange, { start: 0, end: bytes.byteLength, unit: "bytes" });
  const explained = await creator.explain({ receiptId: evidence.receipt.id }); assert.equal(explained.status, "ok");
  assert.equal((await foreign.explain({ receiptId: evidence.receipt.id })).status, "not_found");
  assert.ok(!JSON.stringify(evidence).includes("objectKey")); assert.ok(!JSON.stringify(explained).includes("object_key"));
  await assert.rejects(creator.read({ purpose: "evidence", ref: active.ref, range: { start: 0, end: 65537 } }), rejected(400));
  const current = await readArtifactCurrent(owner, { artifactId: active.manifest.id }); assert.equal(current.status, "ok");
  if (current.status !== "ok") throw Error("Expected current artifact"); assert.equal(current.receipt.purpose, "current");
  assert.deepEqual(current.receipt.actualRange, { start: 0, end: 0, unit: "bytes" });

  const originalKey = (await client`SELECT object_key FROM memory_artifact_manifests WHERE id=${active.manifest.id}`)[0].object_key as string;
  const root = path.resolve(process.env.MEMORY_ARTIFACT_STORAGE_ROOT ?? "");
  assert.ok(root.includes(path.join(".runtime", "memory-module-t5")));
  const physical = path.resolve(root, ...originalKey.split("/")); assert.ok(physical.startsWith(root + path.sep));
  await writeFile(physical, new TextEncoder().encode("CORRUPTED_SYNTHETIC_BYTES"));
  await assert.rejects(readArtifact(owner, { artifactId: active.manifest.id, revision: active.ref.revision }), rejected(409));
  await writeFile(physical, bytes);

  const readTrigger = `t5_read_fault_${randomUUID().replaceAll("-", "")}`;
  await client.unsafe(`CREATE FUNCTION ${readTrigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.user_id='${owner}'::uuid THEN RAISE EXCEPTION 'Synthetic T5 required read receipt fault'; END IF; RETURN NEW; END $$`);
  await client.unsafe(`CREATE TRIGGER ${readTrigger} BEFORE INSERT ON memory_artifact_read_receipts FOR EACH ROW EXECUTE FUNCTION ${readTrigger}()`);
  try { await assert.rejects(creator.read({ purpose: "evidence", ref: active.ref, range: { start: 0, end: 4 } })); }
  finally { await client.unsafe(`DROP TRIGGER ${readTrigger} ON memory_artifact_read_receipts`); await client.unsafe(`DROP FUNCTION ${readTrigger}()`); }

  const deleting = { kind: "artifact.cleanup", commandId: randomUUID(), artifactId: active.manifest.id, expectedRevision: active.manifest.revision };
  const deleteTrigger = `t5_delete_fault_${randomUUID().replaceAll("-", "")}`;
  await client.unsafe(`CREATE FUNCTION ${deleteTrigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.user_id='${owner}'::uuid AND NEW.action='artifact.cleanup' THEN RAISE EXCEPTION 'Synthetic T5 cleanup receipt fault'; END IF; RETURN NEW; END $$`);
  await client.unsafe(`CREATE TRIGGER ${deleteTrigger} BEFORE INSERT ON memory_artifact_command_receipts FOR EACH ROW EXECUTE FUNCTION ${deleteTrigger}()`);
  try {
    await assert.rejects(cleanupArtifact(owner, deleting));
    const interrupted = await readArtifactCurrent(owner, { artifactId: active.manifest.id }); assert.equal(interrupted.status, "ok");
    if (interrupted.status !== "ok") throw Error("Missing recovery manifest");
    assert.equal(interrupted.record.state, "deleting"); assert.equal(interrupted.record.cleanupRecovery?.commandId, deleting.commandId);
    assert.equal(Number((await client`SELECT used_bytes FROM user_file_usage WHERE user_id=${owner}`)[0].used_bytes), bytes.byteLength);
    assert.equal((await readArtifact(owner, { artifactId: active.manifest.id })).status, "unavailable");
  } finally { await client.unsafe(`DROP TRIGGER ${deleteTrigger} ON memory_artifact_command_receipts`); await client.unsafe(`DROP FUNCTION ${deleteTrigger}()`); }
  const cleaned = await cleanupArtifact(owner, deleting); assert.equal(cleaned.manifest.state, "deleted");
  assert.equal((await cleanupArtifact(owner, deleting)).replayed, true);
  assert.equal(Number((await client`SELECT used_bytes FROM user_file_usage WHERE user_id=${owner}`)[0].used_bytes), 0);

  const quotaOwner = randomUUID(); await client`INSERT INTO "User"(id,email) VALUES (${quotaOwner},${quotaOwner + '@example.invalid'})`;
  const reserve = () => beginArtifact(quotaOwner, { ...beginCommand, commandId: randomUUID(), sizeBytes: 150000, sha256: "a".repeat(64) });
  const quotaRace = await Promise.allSettled([reserve(), reserve()]); assert.equal(quotaRace.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(quotaRace.filter(result => result.status === "rejected").length, 1);
  const reserved = quotaRace.find(result => result.status === "fulfilled"); if (!reserved || reserved.status !== "fulfilled") throw Error("No reservation winner");
  await cleanupArtifact(quotaOwner, { kind: "artifact.cleanup", commandId: randomUUID(), artifactId: reserved.value.manifest.id, expectedRevision: reserved.value.manifest.revision });

  const raceBegin = await beginArtifact(owner, { ...beginCommand, commandId: randomUUID() });
  await uploadArtifactBytes(owner, { artifactId: raceBegin.manifest.id, expectedRevision: raceBegin.manifest.revision, data: bytes });
  const raceSeal = await sealArtifact(owner, { kind: "artifact.seal", commandId: randomUUID(), artifactId: raceBegin.manifest.id, expectedRevision: raceBegin.manifest.revision });
  const casRace = await Promise.allSettled([
    activateArtifact(owner, { kind: "artifact.activate", commandId: randomUUID(), artifactId: raceSeal.manifest.id, expectedRevision: raceSeal.manifest.revision }),
    cleanupArtifact(owner, { kind: "artifact.cleanup", commandId: randomUUID(), artifactId: raceSeal.manifest.id, expectedRevision: raceSeal.manifest.revision }),
  ]);
  assert.equal(casRace.filter(result => result.status === "fulfilled").length, 1);
  const afterRace = await readArtifactCurrent(owner, { artifactId: raceSeal.manifest.id }); if (afterRace.status !== "ok") throw Error("Missing race manifest");
  assert.ok(["active", "deleted"].includes(afterRace.record.state));
  if (afterRace.record.state === "active") await cleanupArtifact(owner, { kind: "artifact.cleanup", commandId: randomUUID(), artifactId: afterRace.record.id, expectedRevision: afterRace.record.revision });

  const unsaved = await saveUploadedArtifact(owner, { commandId: randomUUID(), name: "T5-unsaved.txt", contentType: "text/plain", data: bytes, saveRecord: false });
  const listing = await inspectOwnerArtifacts(owner, { limit: 1 }); assert.equal(listing.items.length, 1);
  assert.equal(listing.items[0].manifest.id, unsaved.manifest.id); assert.equal(listing.items[0].manifest.userFileId, null);
  assert.equal(listing.items[0].receipt.purpose, "current"); assert.equal(listing.coverage.bodyIncluded, false);
  await assert.rejects(inspectOwnerArtifacts(other, { limit: 1, cursor: listing.nextCursor ?? "bad-cursor" }), rejected(400));
  await cleanupArtifact(owner, { kind: "artifact.cleanup", commandId: randomUUID(), artifactId: unsaved.manifest.id, expectedRevision: unsaved.manifest.revision });
  return { name: "T5 private artifact lifecycle, byte evidence and durable recovery", passed: true, checks: [
    "public owner commands preserve one manifest for same ID, conflict on changed input and reject authority claims",
    "pending bytes are unreadable; actual private bytes seal then activate with one quota charge and one business reference",
    "fixed binary evidence returns byte windows/base64, actual receipt, owner isolation and integrity mismatch refusal",
    "metadata current reads are distinct from byte evidence; required receipt failure returns no successful body",
    "cleanup interrupted after physical removal retains deleting/quota and recovers with its original command exactly once",
    "two real concurrent reservations cannot overbook; competing activate/cleanup CAS has one winner",
    "unsaved attachments remain visible with current metadata receipts and query-bound owner cursor",
  ] };
}
