import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { DrizzleDB } from "@/lib/db/types";
import { withExecutionContext } from "@/lib/work-runtime/execution-context";
import { acquireMemoryWriteAdvisoryLock } from "@/lib/memory/kernel/locks";
import { MemoryReferenceError, MemoryWriteBusy, assertMemoryReferenceIds } from "@/lib/memory/kernel/reference-errors";

const lease = { userId: "11111111-1111-4111-8111-111111111111", workshopId: "22222222-2222-4222-8222-222222222222",
  runId: "33333333-3333-4333-8333-333333333333", workerId: "test", token: 1 };
const dialect = new PgDialect();
function store(acquired: boolean) {
  const execute = vi.fn<(statement: SQL) => Promise<Array<{ acquired: boolean }>>>().mockResolvedValue([{ acquired }]);
  return { execute, db: { execute } as unknown as DrizzleDB };
}

describe("shared Memory write lock boundary", () => {
  it("uses a blocking transaction lock only outside an active execution", async () => {
    const fixture = store(true);
    await acquireMemoryWriteAdvisoryLock(fixture.db, "owner-scenario-key");
    const query = dialect.sqlToQuery(fixture.execute.mock.calls[0][0]);
    expect(query.sql).toContain("pg_advisory_xact_lock(");
    expect(query.params).toEqual(["owner-scenario-key"]);
  });
  it("uses nonblocking acquisition under a host lease and preserves explicit busy failure", async () => {
    const fixture = store(false);
    await expect(withExecutionContext(lease, () => acquireMemoryWriteAdvisoryLock(fixture.db, "owner-scenario-key")))
      .rejects.toBeInstanceOf(MemoryWriteBusy);
    expect(dialect.sqlToQuery(fixture.execute.mock.calls[0][0]).sql).toContain("pg_try_advisory_xact_lock(");
  });
  it("allows the leased writer only after successful acquisition", async () => {
    const fixture = store(true);
    await expect(withExecutionContext(lease, () => acquireMemoryWriteAdvisoryLock(fixture.db, "owner-scenario-key"))).resolves.toBeUndefined();
  });
  it("rejects malformed references without importing a legacy capability", () => {
    expect(() => assertMemoryReferenceIds([lease.userId, "not-a-reference"])).toThrow(MemoryReferenceError);
    expect(() => assertMemoryReferenceIds([lease.userId])).not.toThrow();
  });
});
