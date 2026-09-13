import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { updateWork, updateWorkLoop, restoreWorkVersion } from "@/lib/work-runtime/commands";
import { getWorkCommand } from "@/lib/work-runtime/command-ledger";

export async function checkWorkCommandBusiness(client: postgres.Sql) {
  const ownerId = randomUUID(), workId = randomUUID(), commandId = randomUUID();
  await client`INSERT INTO "User" (id,email) VALUES (${ownerId},'command-business@example.invalid')`;
  await client`INSERT INTO workshops (id,user_id,name,mission) VALUES (${workId},${ownerId},'before','command business')`;
  const command = {userId: ownerId, workId, commandId, expectedVersion: 0, patch: {name: "配置事务回测", heartbeat: {enabled: false, nextWakeupAt: new Date("2026-09-07T00:00:00Z")}}};
  const first = await updateWork(command), replay = await updateWork(command);
  assert.deepEqual(first, replay);
  assert(first.workshop.updatedAt instanceof Date);
  assert(first.heartbeat?.nextWakeupAt instanceof Date);
  assert.equal(first.workshop.name, "配置事务回测");
  assert.equal((await getWorkCommand(ownerId, commandId))?.status, "succeeded");
  const [counts] = await client`SELECT (SELECT count(*)::int FROM workshop_work_versions WHERE workshop_id=${workId}) AS versions,
    (SELECT count(*)::int FROM workshop_heartbeats WHERE workshop_id=${workId}) AS heartbeats`;
  assert.deepEqual(counts, {versions: 1, heartbeats: 1});
  const badId = randomUUID();
  await assert.rejects(updateWork({...command, commandId: badId, expectedVersion: 1, patch: {name: "must roll back", heartbeat: {mode: "cron", nextWakeupAt: new Date("invalid")}}}));
  await assert.rejects(updateWork({...command, commandId: badId, expectedVersion: 1, patch: {name: "must roll back", heartbeat: {mode: "x".repeat(1000) as "cron"}}}));
  assert.equal((await getWorkCommand(ownerId, badId))?.status, "queued");
  assert.equal((await client`SELECT name FROM workshops WHERE id=${workId}`)[0].name, "配置事务回测");
  assert.equal((await client`SELECT count(*)::int AS n FROM workshop_work_versions WHERE workshop_id=${workId}`)[0].n, 1);
  await assert.rejects(updateWork({...command, patch: {name: "different"}}), /payload_conflict/);
  const loopId = randomUUID();
  await client`INSERT INTO loops(id,user_id,workshop_id,name,goal,status) VALUES (${loopId},${ownerId},${workId},'loop fixture','test','active')`;
  const loopCommand = {userId: ownerId, workId, loopId, commandId: randomUUID(), expectedVersion: 1,
    patch: {status: "paused" as const, triggerConfig: {type: "cron" as const, expression: "0 9 * * 1-5", timezone: "Asia/Shanghai"}}};
  const loopResult = await updateWorkLoop(loopCommand);
  assert.equal(loopResult.loop.status, "paused");
  assert.deepEqual(await updateWorkLoop(loopCommand), loopResult);
  assert.equal((await client`SELECT state_json FROM loop_states WHERE loop_id=${loopId}`)[0].state_json.nextScheduledRunAt, loopResult.nextScheduledRunAt);
  assert(loopResult.nextScheduledRunAt);
  const [snapshot] = await client`SELECT id FROM workshop_work_versions WHERE workshop_id=${workId}`;
  const restore = {userId: ownerId, workId, commandId: randomUUID(), expectedVersion: 2, versionId: snapshot.id};
  const restored = await restoreWorkVersion(restore);
  assert.deepEqual(await restoreWorkVersion(restore), restored);
  assert.equal(restored.workshop.name, "配置事务回测");
  assert(restored.workshop.updatedAt instanceof Date);
  assert.equal((await client`SELECT count(*)::int AS n FROM workshop_work_versions WHERE workshop_id=${workId}`)[0].n, 2);
  return {name: "actual updateWork/updateWorkLoop/restoreWorkVersion atomically commit state, schedule, snapshots and events; Date-preserving replay", passed: true};
}
