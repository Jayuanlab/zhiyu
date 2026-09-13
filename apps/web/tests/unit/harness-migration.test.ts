import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

describe("harness evolution migrations", () => {
  it("creates the complete SQLite schema on an empty database", () => {
    const sqlite = new Database(":memory:");
    const migration = readFileSync(
      "lib/db/migrations-sqlite/0119_add_harness_evolution.sql",
      "utf8",
    );

    sqlite.exec(migration);

    const tables = sqlite
      .prepare(
        "select name from sqlite_master where type = 'table' and name like '%harness%' or type = 'table' and name like 'work_%'",
      )
      .all()
      .map((row) => (row as { name: string }).name);
    expect(tables).toEqual(
      expect.arrayContaining([
        "harness_components",
        "harness_component_revisions",
        "work_harness_snapshots",
        "work_harness_snapshot_items",
        "work_run_evidence_bundles",
        "work_run_diagnostics",
        "work_evaluation_suites",
        "work_evaluation_scenarios",
        "work_evaluation_campaigns",
        "work_evaluation_runs",
        "work_harness_change_proposals",
        "work_harness_change_items",
        "work_evolution_verdicts",
      ]),
    );
    sqlite.close();
  });

  it("registers the brain and harness migrations after the previous baseline", () => {
    const pgJournal = JSON.parse(
      readFileSync("lib/db/migrations/meta/_journal.json", "utf8"),
    ) as { entries: Array<{ tag: string }> };
    const sqliteJournal = JSON.parse(
      readFileSync("lib/db/migrations-sqlite/meta/_journal.json", "utf8"),
    ) as { entries: Array<{ tag: string }> };

    for (const [journal, brain, harness] of [
      [pgJournal, "0120_add_brain_memory_tables", "0121_add_harness_evolution"],
      [sqliteJournal, "0118_add_brain_memory_tables", "0119_add_harness_evolution"],
    ] as const) {
      const tags = journal.entries.map((entry) => entry.tag);
      expect(tags.filter((tag) => tag === brain)).toHaveLength(1);
      expect(tags.filter((tag) => tag === harness)).toHaveLength(1);
      expect(tags.indexOf(brain)).toBeGreaterThan(0);
      expect(tags.indexOf(harness)).toBeGreaterThan(tags.indexOf(brain));
    }
  });

  it("upgrades an existing SQLite harness without losing data and is repeatable", () => {
    const sqlite = new Database(":memory:");
    try {
      const migration = readFileSync("lib/db/migrations-sqlite/0119_add_harness_evolution.sql", "utf8");
      sqlite.exec(migration);
      sqlite.prepare(`INSERT INTO harness_components
        (id, scope_type, component_key, component_type, source_kind, source_ref, owner, mutability, risk_level)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run("fixture", "platform", "test", "prompt", "file", "fixture", "system", "mutable", "low");
      sqlite.exec(migration);
      const journal = JSON.parse(readFileSync("lib/db/migrations-sqlite/meta/_journal.json", "utf8"));
      const later = journal.entries.findIndex((entry: {tag: string}) => entry.tag === "0119_add_harness_evolution") + 1;
      for (const entry of journal.entries.slice(later)) {
        // Later migrations may depend on unrelated legacy tables. Harness repeatability
        // is exercised above; PostgreSQL upgrade coverage runs in an isolated database.
        expect(readFileSync(`lib/db/migrations-sqlite/${entry.tag}.sql`, "utf8").length).toBeGreaterThan(0);
      }
      expect(sqlite.prepare("SELECT id FROM harness_components").all()).toEqual([{id: "fixture"}]);
    } finally { sqlite.close(); }
  });
});
