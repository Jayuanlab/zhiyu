import fs from "node:fs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import postgres from "postgres";
import { brainMemoryFromRow } from "@/lib/memory/records/memory-record";
import {
  inferRecordClass,
  makeRecordLifecycle,
  recordLifecycleView,
  memoryRecallOmitReason,
} from "@/lib/memory/records/lifecycle";
import { memorySourceCatalog } from "@/lib/memory/sources/catalog";
import { getBrainMemoryRevisionVersion } from "@/lib/memory/revision/version";
const now = new Date("2026-10-21T04:10:00.000Z"),
  dir = process.env.G2_RECORD_DIR!,
  sql = postgres(process.env.POSTGRES_URL!, { max: 1, onnotice: () => {} }),
  hash = (v: unknown) =>
    createHash("sha256").update(JSON.stringify(v)).digest("hex");
function comparable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(comparable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => k !== "policy")
        .map(([k, v]) => [k, comparable(v)]),
    );
  return value;
}
async function main() {
  try {
    const all = await sql`select * from brain_memories order by id`,
      memories = all.map((r) => brainMemoryFromRow(r as any));
    const decisions = memories.map((m) => ({
      id: m.id,
      version: getBrainMemoryRevisionVersion(m),
      inferred: inferRecordClass(m),
      window: comparable(makeRecordLifecycle(m, "run_record", "matched", now)),
      view: comparable(recordLifecycleView(m, now)),
      omitted: memoryRecallOmitReason(m),
    }));
    const tables: Record<string, { count: number; hash: string }> = {};
    for (const t of [
      "brain_memories",
      "brain_observations",
      "memory_operation_receipts",
      "memory_read_receipts",
      "workshop_runs",
      "loop_runs",
      "loops",
    ]) {
      const rows = await sql`select * from ${sql(t)} order by id`;
      tables[t] = { count: rows.length, hash: hash(rows) };
    }
    const worker =
      await sql`select id,desired_status,phase,last_heartbeat_at from runtime_instances where id='751b64a7-1703-4a16-8b30-9f326490eeea'`;
    const record = {
      at: new Date().toISOString(),
      decisions,
      catalog: memorySourceCatalog(),
      tables,
      worker,
    };
    if (process.argv.includes("--before")) {
      fs.writeFileSync(
        dir + "/baseline-private.json",
        JSON.stringify(record, null, 2),
        { flag: "wx" },
      );
      console.log(
        JSON.stringify({ saved: true, memories: all.length, tables }),
      );
    } else {
      const baseline = JSON.parse(
        fs.readFileSync(dir + "/baseline-private.json", "utf8"),
      );
      assert.deepEqual(record.decisions, baseline.decisions);
      assert.deepEqual(record.catalog, baseline.catalog);
      assert.deepEqual(record.tables, baseline.tables);
      assert.deepEqual(
        JSON.parse(JSON.stringify(record.worker)),
        baseline.worker,
      );
      fs.writeFileSync(
        dir + "/matched-final.json",
        JSON.stringify(
          {
            passed: true,
            at: record.at,
            matchedMemories: all.length,
            catalogUnchanged: true,
            allCheckedTablesUnchanged: true,
            tables,
            workerUnchanged: true,
          },
          null,
          2,
        ),
      );
      console.log(
        JSON.stringify({
          passed: true,
          matchedMemories: all.length,
          catalogUnchanged: true,
          tablesUnchanged: true,
        }),
      );
    }
  } finally {
    await sql.end();
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
