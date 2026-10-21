import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/** Seed only the fresh fixture immediately before the actual revision migration. */
export async function seedMemoryModuleT2LegacyTasks(client, expectedDatabase) {
  assert.match(expectedDatabase, /^zhiyu_test_[a-f0-9]{32}$/);
  assert.equal((await client`SELECT current_database() AS name`)[0].name, expectedDatabase);
  const column = await client`SELECT 1 FROM information_schema.columns WHERE table_schema='public'
    AND table_name='interaction_tasks' AND column_name='revision'`;
  assert.equal(column.length, 0, 'Migration fixture must be inserted before the revision column exists');
  const owner = randomUUID();
  await client`INSERT INTO "User"(id,email) VALUES (${owner},${owner + '@example.invalid'})`;
  const cases = [
    { id: randomUUID(), expectedVersion: 7, metadata: { fixture: 't2_pre_revision_migration', legacyMarker: 'preserved',
      taskState: { version: 7, verificationStatus: 'confirmed', taskStatus: 'open' } } },
    { id: randomUUID(), expectedVersion: 0, metadata: { fixture: 't2_pre_revision_migration', legacyMarker: 'default-version' } },
  ];
  for (const fixture of cases) await client`INSERT INTO interaction_tasks(id,user_id,title,status,source_event_ids,metadata)
    VALUES (${fixture.id},${owner},'Synthetic pre-revision task','candidate',${JSON.stringify([])}::jsonb,${JSON.stringify(fixture.metadata)}::jsonb)`;
  return { owner, cases, schemaBefore: 'revision_column_absent', databaseScope: 'synthetic_isolated' };
}
