import assert from "node:assert/strict";
import { config } from "dotenv";

config({path: ".env.local", quiet: true});
config({path: ".env", quiet: true});

const ownerId = process.env.ZHIYU_OWNER_ID;
const workId = process.env.ZHIYU_WORK_ID;
assert.match(ownerId ?? "", /^[a-f\d-]{36}$/i);
assert.match(workId ?? "", /^[a-f\d-]{36}$/i);

const [{getOwnerWorkOverview}, {closeDb}] = await Promise.all([
  import("@/lib/workshops/owner-overview"),
  import("@/lib/db/adapters"),
]);
try {
  const overview = await getOwnerWorkOverview(ownerId!);
  const selected = overview.works.find((item) => item.workId === workId);
  assert.ok(selected, "selected_work_missing");
  const stranger = await getOwnerWorkOverview("00000000-0000-4000-8000-000000000000");
  assert.equal(stranger.works.length, 0, "owner_scope_leak");
  console.log(JSON.stringify({asOf: overview.asOf, workCount: overview.works.length,
    selected, ownerScopeIsolated: true}, null, 2));
} finally {
  await closeDb();
}
