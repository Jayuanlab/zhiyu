import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** Keep the provider's zero-byte retirement fences as synthetic evidence. */
export async function cleanupMemoryModuleT5({ client, records, database }) {
  assert.match(database, /^zhiyu_test_[a-f0-9]{32}$/);
  assert.equal(String((await client`SELECT current_database() AS name`)[0].name), database);
  const root = path.resolve(records, 'private-objects');
  assert.equal(path.resolve(process.env.MEMORY_ARTIFACT_STORAGE_ROOT ?? ''), root);
  assert.ok(root.startsWith(path.resolve(records) + path.sep));
  const { cleanupArtifact } = await import('../../lib/memory/artifacts/service.ts');
  const rows = await client`SELECT id,user_id,state,revision,metadata FROM memory_artifact_manifests WHERE state <> 'deleted'`;
  for (const row of rows) {
    const recovery = row.metadata?.cleanupIntent;
    await cleanupArtifact(row.user_id, { kind: 'artifact.cleanup', commandId: recovery?.commandId ?? randomUUID(),
      artifactId: row.id, expectedRevision: recovery?.fromRevision ?? row.revision });
  }
  let fences = 0, bodyBytes = 0;
  async function inspect(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const target = path.resolve(directory, entry.name); assert.ok(target.startsWith(root + path.sep));
      assert.ok(!entry.isSymbolicLink(), 'Owned cleanup cannot follow links');
      if (entry.isDirectory()) await inspect(target);
      else { const stat = await fs.stat(target); assert.ok(stat.isFile()); bodyBytes += stat.size; fences++; }
    }
  }
  await inspect(root); assert.equal(bodyBytes, 0, 'All synthetic private bodies must be removed through Memory cleanup');
  assert.equal(Number((await client`SELECT count(*)::int AS n FROM memory_artifact_manifests WHERE state <> 'deleted'`)[0].n), 0);
  return { passed: true, scope: 'owned_synthetic_directory', activeBodies: 0, bodyBytes, retirementFencesRetained: fences };
}
