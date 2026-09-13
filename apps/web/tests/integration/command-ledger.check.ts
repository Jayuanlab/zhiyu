import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type postgres from "postgres";
import { acceptLocalWorkCommand, executeLocalWorkCommand, getWorkCommand, getWorkCommandVersion, type LocalWorkCommand } from "@/lib/work-runtime/command-ledger";

function causedBy(message: string) {
  return (error: unknown): boolean => {
    while (error instanceof Error) {
      if (error.message === message) return true;
      error = error.cause;
    }
    return false;
  };
}

export async function checkCommandLedger(client: postgres.Sql) {
  const ownerId = randomUUID(), otherId = randomUUID(), workId = randomUUID(), otherWorkId = randomUUID();
  await client`INSERT INTO "User" (id,email) VALUES (${ownerId},'commands@example.invalid'),(${otherId},'other-command-owner@example.invalid')`;
  await client`INSERT INTO workshops (id,user_id,name,mission) VALUES (${workId},${ownerId},'before','commands'),(${otherWorkId},${otherId},'other','commands')`;
  const command: LocalWorkCommand = {ownerId, workId, commandId: randomUUID(), type: "fixture.rename", expectedVersion: 0, payload: {name: "事务回测", info: {b: 2, a: 1}}};
  assert.equal(await getWorkCommandVersion(ownerId, workId), 0);
  await assert.rejects(getWorkCommandVersion(otherId, workId), /not_found/);
  const accepted = await acceptLocalWorkCommand(command);
  assert.equal(accepted.status, "queued");
  assert.deepEqual((await acceptLocalWorkCommand({...command, payload: {info: {a: 1, b: 2}, name: "事务回测"}})), accepted);
  await assert.rejects(acceptLocalWorkCommand({...command, payload: {name: "different"}}), /payload_conflict/);
  await assert.rejects(acceptLocalWorkCommand({...command, type: "different"}), /payload_conflict/);
  await assert.rejects(acceptLocalWorkCommand({...command, expectedVersion: 1}), /payload_conflict/);
  await assert.rejects(acceptLocalWorkCommand({...command, ownerId: otherId}), /not_found/);
  assert.equal(await getWorkCommand(otherId, command.commandId), null);
  await assert.rejects(executeLocalWorkCommand(otherId, command.commandId, command.type, async () => null), /not_found/);
  await assert.rejects(executeLocalWorkCommand(ownerId, command.commandId, "wrong.handler", async () => null), /payload_conflict/);
  // Same id in a different owner's namespace is independent.
  assert.equal((await acceptLocalWorkCommand({...command, ownerId: otherId, workId: otherWorkId})).status, "queued");

  const competing = {...command, commandId: randomUUID()};
  await acceptLocalWorkCommand(competing); // Both are accepted at revision zero.
  await assert.rejects(executeLocalWorkCommand(ownerId, command.commandId, command.type, async tx => {
    await tx.execute(sql`UPDATE workshops SET name='rollback' WHERE id=${workId}::uuid`);
    throw new Error("injected handler failure");
  }), /injected handler failure/);
  assert.equal((await getWorkCommand(ownerId, command.commandId))?.status, "queued");
  assert.equal((await client`SELECT name FROM workshops WHERE id=${workId}`)[0].name, "before");
  // Fail the LAST write, after the business update/result/version were written.
  await client.unsafe(`CREATE FUNCTION reject_command_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type = 'work_command_accepted' THEN RAISE EXCEPTION 'injected acceptance failure'; END IF; RETURN NEW; END $$`);
  await client.unsafe(`CREATE TRIGGER reject_command_event BEFORE INSERT ON workshop_events FOR EACH ROW EXECUTE FUNCTION reject_command_event()`);
  const rejectedId = randomUUID();
  await assert.rejects(acceptLocalWorkCommand({...command, commandId: rejectedId}), causedBy("injected acceptance failure"));
  assert.equal(await getWorkCommand(ownerId, rejectedId), null);
  await client.unsafe(`CREATE OR REPLACE FUNCTION reject_command_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type = 'work_command_applied' THEN RAISE EXCEPTION 'injected event failure'; END IF; RETURN NEW; END $$`);
  const handler = async (tx: Parameters<Parameters<typeof executeLocalWorkCommand>[3]>[0], payload: unknown) => {
    assert.deepEqual(payload, command.payload);
    await tx.execute(sql`UPDATE workshops SET name=${"事务回测"} WHERE id=${workId}::uuid`);
    return {name: "事务回测", nested: {ok: true}, values: [1, 2]};
  };
  try { await assert.rejects(executeLocalWorkCommand(ownerId, command.commandId, command.type, handler), causedBy("injected event failure")); }
  finally { await client.unsafe('DROP TRIGGER reject_command_event ON workshop_events'); await client.unsafe('DROP FUNCTION reject_command_event()'); }
  assert.equal((await getWorkCommand(ownerId, command.commandId))?.status, "queued");
  assert.equal((await client`SELECT name FROM workshops WHERE id=${workId}`)[0].name, "before");
  assert.equal((await client`SELECT version FROM work_command_targets WHERE workshop_id=${workId}`)[0].version, 0);
  const result = await executeLocalWorkCommand(ownerId, command.commandId, command.type, handler);
  assert.equal(await getWorkCommandVersion(ownerId, workId), 1);
  assert.equal(result.status, "succeeded");
  assert.equal((result.result as {name: string}).name, "事务回测");
  const replay = await executeLocalWorkCommand(ownerId, command.commandId, command.type, async () => {throw new Error("must not execute again");});
  assert.deepEqual(replay, result);
  assert.deepEqual(await acceptLocalWorkCommand(command), result);
  assert.equal((await client`SELECT jsonb_typeof(result) AS kind FROM work_commands WHERE owner_id=${ownerId} AND command_id=${command.commandId}`)[0].kind, "object");
  const conflict = await executeLocalWorkCommand(ownerId, competing.commandId, command.type, async () => {throw new Error("stale handler must not run");});
  assert.equal(conflict.status, "failed"); assert.equal(conflict.errorCode, "version_conflict");
  assert.deepEqual(await executeLocalWorkCommand(ownerId, competing.commandId, command.type, async () => null), conflict);
  const staleId = randomUUID();
  await assert.rejects(acceptLocalWorkCommand({...command, commandId: staleId}), /version_conflict/);
  assert.equal(await getWorkCommand(ownerId, staleId), null);
  const events = await client`SELECT type,seq FROM workshop_events WHERE workshop_id=${workId} ORDER BY seq`;
  assert.deepEqual(events.map(e => e.type), ["work_command_accepted", "work_command_accepted", "work_command_applied", "work_command_failed"]);
  assert.deepEqual(events.map(e => e.seq), [1,2,3,4]);
  await client`DELETE FROM workshops WHERE id=${workId}`;
  assert.deepEqual(await getWorkCommand(ownerId, command.commandId), result);
  await assert.rejects(executeLocalWorkCommand(ownerId, command.commandId, command.type, async () => null), /not_found/);
  return {name: "owner isolation, stable receipts, payload/version conflicts, state/result/event rollback and UTF-8", passed: true, events: events.length};
}
