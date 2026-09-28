import { and, count, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import * as s from "@/lib/db/schema";

// Aggregation is separate from paginated discovery. Only dimensions are
// selected: model credentials and component configuration are never read.
export async function readPlatformStatisticsForOwner(input: { userId: string }) {
  const workIds = db.select({ id: s.workshops.id }).from(s.workshops).where(eq(s.workshops.userId, input.userId));
  const componentsOwned = and(inArray(s.harnessComponents.scopeType, ["work", "workshop"]),
    inArray(s.harnessComponents.scopeId, db.select({ id: sql<string>`cast(${s.workshops.id} as text)` }).from(s.workshops).where(eq(s.workshops.userId, input.userId))));
  const specs = [
    ["workshops.status", s.workshops, s.workshops.status, eq(s.workshops.userId, input.userId)],
    ["loops.status", s.loops, s.loops.status, eq(s.loops.userId, input.userId)],
    ["brainMemories.status", s.brainMemories, s.brainMemories.status, eq(s.brainMemories.userId, input.userId)],
    ["brainMemories.canonicalKind", s.brainMemories, s.brainMemories.canonicalKind, eq(s.brainMemories.userId, input.userId)],
    ["interactionEvents.processedStatus", s.interactionEvents, s.interactionEvents.processedStatus, eq(s.interactionEvents.userId, input.userId)],
    ["interactionProcessingJobs.status", s.interactionProcessingJobs, s.interactionProcessingJobs.status, eq(s.interactionProcessingJobs.userId, input.userId)],
    ["workshopOutbox.status", s.workshopOutbox, s.workshopOutbox.status, inArray(s.workshopOutbox.workshopId, workIds)],
    ["ragDocuments.contentType", s.ragDocuments, s.ragDocuments.contentType, eq(s.ragDocuments.userId, input.userId)],
    ["modelConfiguration.enabled", s.userLlmApiSettings, s.userLlmApiSettings.enabled, eq(s.userLlmApiSettings.userId, input.userId)],
    ["harnessComponents.componentType", s.harnessComponents, s.harnessComponents.componentType, componentsOwned],
    ["harnessComponentRevisions.status", s.harnessComponentRevisions, s.harnessComponentRevisions.status, inArray(s.harnessComponentRevisions.componentId, db.select({ id: s.harnessComponents.id }).from(s.harnessComponents).where(componentsOwned))],
    ["workCommands.status", s.workCommands, s.workCommands.status, eq(s.workCommands.ownerId, input.userId)],
    ["workRunEvidenceBundles.captureStatus", s.workRunEvidenceBundles, s.workRunEvidenceBundles.captureStatus, eq(s.workRunEvidenceBundles.userId, input.userId)],
  ] as const;
  const results = [];
  for (const [source, table, dimension, owned] of specs) {
    try {
      const groups = await db.select({ value: dimension, count: count() }).from(table).where(owned).groupBy(dimension);
      results.push({ source, status: "ok", total: groups.reduce((sum: number, row: { count: number }) => sum + Number(row.count), 0), groups });
    } catch { results.push({ source, status: "unavailable" }); }
  }
  const ledgerQueries = [
    ["paper_accounts.version", sql`SELECT version AS value, count(*)::int AS count FROM paper_accounts WHERE owner_id=${input.userId}::uuid GROUP BY version`],
    ["paper_orders.status", sql`SELECT o.status AS value, count(*)::int AS count FROM paper_orders o JOIN paper_accounts a ON a.id=o.account_id WHERE a.owner_id=${input.userId}::uuid GROUP BY o.status`],
    ["workshop_heartbeats.scheduler_status", sql`SELECT h.scheduler_status AS value, count(*)::int AS count FROM workshop_heartbeats h JOIN workshops w ON w.id=h.workshop_id WHERE w.user_id=${input.userId}::uuid GROUP BY h.scheduler_status`],
  ] as const;
  for (const [source, query] of ledgerQueries) {
    try {
      const groups = Array.from(await db.execute(query)) as Array<{ value: unknown; count: number }>;
      results.push({ source, status: "ok", total: groups.reduce((sum, row) => sum + Number(row.count), 0), groups });
    } catch { results.push({ source, status: "unavailable" }); }
  }
  return { scope: "authenticated_owner", freshness: "live_read", observedAt: new Date().toISOString(),
    sourceSemantics: {
      "paper_accounts.version": "模拟交易账户及账户状态版本。",
      "paper_orders.status": "模拟交易委托（纸面交易订单）的状态；这是模拟委托的准确数据源，不是消息或外发队列。",
      "workshopOutbox.status": "消息外发队列状态，不是交易委托，不能替代或合并进模拟委托统计。",
      "workshop_heartbeats.scheduler_status": "当前用户的车间心跳表记录。计数为零不代表所有持续任务未运行。",
    },
    warning: "These are current database counts, not a historical evaluation snapshot. Do not present current counts as historical facts. Null dimensions mean unclassified. An unavailable source is not an empty source.", results };
}
