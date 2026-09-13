import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { readWorkStatusProjection } from "@/lib/workshops/status-projection";
import { getWorkSummarySnapshot } from "@/lib/work-runtime/queries";
import { getWorkshopDashboard } from "@/lib/workshops/dashboard";
import { summarySnapshotToPageState } from "@/lib/workshops/summary-page-state";

export async function checkWorkProjection(sql: postgres.Sql) {
  const userId = randomUUID(), otherUser = randomUUID(), workId = randomUUID();
  await sql`INSERT INTO "User" (id, email) VALUES (${userId}, 'projection@test.invalid'), (${otherUser}, 'other@test.invalid')`;
  await sql`INSERT INTO workshops (id, user_id, name, mission) VALUES (${workId}, ${userId}, 'fixture', 'test projection')`;
  await sql`INSERT INTO loops (user_id, workshop_id, name, goal, status)
    SELECT ${userId}::uuid, ${workId}::uuid, 'fixture-' || n, 'test', 'active' FROM generate_series(1, 250) n`;
  const rows = await sql`SELECT id FROM loops WHERE workshop_id = ${workId} ORDER BY name`;
  await sql`UPDATE loops SET status = 'paused' WHERE id IN (${rows[0].id}, ${rows[1].id})`;
  await sql`INSERT INTO loop_states (loop_id, current_phase, state_json) VALUES
    (${rows[0].id}, 'idle', '{}'::jsonb),
    (${rows[1].id}, 'approval', '{"requiresOwnerActivation":true}'::jsonb),
    (${rows[2].id}, 'blocked', '{}'::jsonb),
    (${rows[3].id}, 'error', '{}'::jsonb)`;
  await sql`INSERT INTO workshop_outbox (workshop_id, channel, message, status)
    SELECT ${workId}::uuid, 'wechat_desktop', 'fixture draft', 'draft' FROM generate_series(1, 600)`;
  await sql`INSERT INTO workshop_outbox (workshop_id, channel, message, status, boundary_result) VALUES
    (${workId}, 'wechat_desktop', 'approval fixture', 'pending_approval', '{"source":"loop_suggested_action"}'),
    (${workId}, 'wechat_desktop', 'internal fixture', 'draft', '{"source":"loop_suggested_action"}')`;
  await sql`INSERT INTO workshop_events (workshop_id, seq, type, title)
    SELECT ${workId}::uuid, n, 'observation', 'fixture event' FROM generate_series(1, 101) n`;
  const projection = await readWorkStatusProjection({userId, workId});
  assert(projection);
  assert.equal(projection.counts.loops, 250);
  assert.equal(projection.counts.pendingOutbox, 601);
  assert.equal(projection.counts.pendingApprovals, 2);
  assert.equal(projection.counts.pendingLoopProposals, 1);
  assert.equal(projection.counts.blockedLoops, 1);
  assert.equal(projection.counts.errorLoops, 1);
  assert.equal(await readWorkStatusProjection({userId: otherUser, workId}), null);
  const summary = await getWorkSummarySnapshot({userId, workId});
  const dashboard = await getWorkshopDashboard({userId, workshopId: workId});
  assert(summary && dashboard);
  assert.deepEqual(summary.dashboard.counts, dashboard.counts);
  const page = summarySnapshotToPageState(summary);
  assert.equal(page.eventWindow.lastSeq, 101);
  assert.equal(page.eventWindow.firstSeq, 82);
  assert.equal(page.eventWindow.hasMore, true);
  assert.equal(await getWorkSummarySnapshot({userId: otherUser, workId}), null);
  // No zero-success fallback when a required status query fails.
  await sql`ALTER TABLE loop_states RENAME TO unavailable_loop_states`;
  await assert.rejects(() => readWorkStatusProjection({userId, workId}));
  await sql`ALTER TABLE unavailable_loop_states RENAME TO loop_states`;
  return {name: 'status projection and real summary/dashboard parity with pagination and owner isolation', passed: true,
    loops: 250, outboxRows: 602, pendingOutbox: 601, latestEvent: 101, failureDoesNotBecomeZero: true};
}
