import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type postgres from "postgres";
import { withWorkshopEventTransaction } from "@/lib/workshops/event-write";
import { subscribeWorkshopEvents } from "@/lib/workshops/event-bus";

export async function checkEventTransactions(client: postgres.Sql) {
  const userId = randomUUID(), workId = randomUUID();
  await client`INSERT INTO "User" (id,email) VALUES (${userId},'event-tx@example.invalid')`;
  await client`INSERT INTO workshops (id,user_id,name,mission) VALUES (${workId},${userId},'before','transaction regression')`;
  const published: number[] = [];
  const unsubscribe = subscribeWorkshopEvents(workId, event => published.push(event.seq));
  try {
    await assert.rejects(withWorkshopEventTransaction(async (tx, append) => {
      await tx.execute(sql`UPDATE workshops SET name='rolled-back' WHERE id=${workId}::uuid`);
      await append({workshopId: workId, type: "observation", title: "不得发布的回滚事件"});
      assert.equal(published.length, 0);
      throw new Error("injected rollback");
    }), /injected rollback/);
    assert.equal((await client`SELECT name FROM workshops WHERE id=${workId}`)[0].name, "before");
    assert.equal((await client`SELECT * FROM workshop_event_counters WHERE workshop_id=${workId}`).length, 0);
    assert.equal(published.length, 0);

    await withWorkshopEventTransaction(async (tx, append) => {
      await tx.execute(sql`UPDATE workshops SET name='committed' WHERE id=${workId}::uuid`);
      await append({workshopId: workId, type: "observation", title: "事务一致提交", metadata: {来源: "隔离回测", values: [1,2]}});
      await append({workshopId: workId, type: "observation", title: "同事务第二条"});
      assert.equal(published.length, 0);
      assert.equal((await client`SELECT name FROM workshops WHERE id=${workId}`)[0].name, "before");
    });
    assert.deepEqual(published, [1,2]);
    const rows = await client`SELECT title,metadata,jsonb_typeof(metadata) AS kind FROM workshop_events WHERE workshop_id=${workId} ORDER BY seq`;
    assert.equal(rows[0].title, "事务一致提交");
    assert.equal(rows[0].kind, "object"); assert.equal(rows[0].metadata.来源, "隔离回测");
    assert.equal((await client`SELECT name FROM workshops WHERE id=${workId}`)[0].name, "committed");

    await assert.rejects(withWorkshopEventTransaction(async (tx, append) => {
      await tx.execute(sql`UPDATE workshops SET name='invalid-event' WHERE id=${workId}::uuid`);
      await append({workshopId: workId, loopRunId: randomUUID(), type: "observation", title: "invalid foreign key"});
    }));
    assert.equal((await client`SELECT last_seq FROM workshop_event_counters WHERE workshop_id=${workId}`)[0].last_seq, 2);
    assert.equal((await client`SELECT name FROM workshops WHERE id=${workId}`)[0].name, "committed");
    assert.deepEqual(published, [1,2]);
    return {name: "state/event rollback, commit visibility, failed insert and UTF-8 JSON", passed: true};
  } finally { unsubscribe(); }
}
