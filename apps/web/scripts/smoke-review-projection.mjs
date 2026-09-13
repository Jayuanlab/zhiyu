import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const base = "http://127.0.0.1:3516";
async function get(route) {
  const response = await fetch(base + route);
  if (!response.ok) throw new Error(`${route}: ${response.status}`);
  return response.json();
}
const index = await get("/api/page-state/workshop");
const checks = [];
for (const item of index.workshops.slice(0, 3)) {
  const id = item.id;
  const [summary, dashboard, events] = await Promise.all([
    get(`/api/workshops/${id}/summary`),
    get(`/api/workshops/${id}/dashboard?refresh=1`),
    get(`/api/workshops/${id}/events?limit=100`),
  ]);
  const window = await get(`/api/page-state/workshop/${id}/summary`);
  const countsMatch = JSON.stringify(summary.dashboard.counts) === JSON.stringify(dashboard.counts);
  const summaryLast = Math.max(...summary.events.map(event => event.seq));
  const latest = Math.max(...events.events.map(event => event.seq));
  checks.push({ workshopId: id, countsMatch,
    statusMatch: summary.dashboard.status === dashboard.status,
    summaryLast, latest, windowLast: window.eventWindow?.lastSeq,
    windowSize: window.events.length, hasMore: window.eventWindow?.hasMore,
    projection: dashboard.projection, counts: dashboard.counts });
}
const report = { testedAt: new Date().toISOString(), origin: base,
  buildId: fs.readFileSync(path.join(root, "apps/web/.tmp/next-review-02/BUILD_ID"), "utf8").trim(), checks };
fs.writeFileSync(path.join(root, "docs/plans/2026-09-06-review-remediation/records/02-production-smoke.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
if (checks.some(check => !check.countsMatch || !check.statusMatch || check.summaryLast !== check.latest || check.windowLast !== check.latest)) {
  throw new Error("Projection parity failed; compare cursors before interpreting concurrent updates.");
}
