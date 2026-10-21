import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
type Condition = { op: "eq"; column: string; value: unknown } | { op: "and"; values: Condition[] }
  | { op: "in"; column: string; values: unknown[] } | { op: "sql"; text: string };
const fixture = vi.hoisted(() => ({ authenticated: true, lease: false, calls: 0, writes: 0,
  rows: {} as Record<string, Row[]>, fail: false,
  tables: {
    workshops: { name: "workshops", id: "workshops.id", userId: "workshops.userId", updatedAt: "workshops.updatedAt" },
    loops: { name: "loops", id: "loops.id", userId: "loops.userId", workshopId: "loops.workshopId" },
    events: { name: "events", id: "events.id", workshopId: "events.workshopId", loopId: "events.loopId", loopRunId: "events.loopRunId",
      runId: "events.runId", createdAt: "events.createdAt", type: "events.type", metadata: "events.metadata", seq: "events.seq" },
  },
}));
vi.mock("@/app/(auth)/auth", () => ({ auth: async () => fixture.authenticated ? { user: { id: "11111111-1111-4111-8111-111111111111" } } : null }));
vi.mock("@/lib/work-runtime/execution-context", () => ({ resolveExecutionLease: () => fixture.lease ? { userId: "11111111-1111-4111-8111-111111111111" } : undefined }));
vi.mock("@/lib/db/schema", () => ({ workshops: fixture.tables.workshops, loops: fixture.tables.loops, workshopEvents: fixture.tables.events }));
vi.mock("drizzle-orm", () => ({ eq: (column: string, value: unknown) => ({ op: "eq", column, value }),
  and: (...values: Array<Condition | undefined>) => ({ op: "and", values: values.filter(Boolean) }),
  inArray: (column: string, values: unknown[]) => ({ op: "in", column, values }), desc: (column: string) => column,
  sql: (strings: TemplateStringsArray) => ({ op: "sql", text: strings.join("?") }),
}));
vi.mock("@/lib/db/client", () => {
  function match(row: Row, condition: Condition): boolean {
    if (condition.op === "and") return condition.values.every(value => match(row, value));
    if (condition.op === "sql") return !condition.text.includes("receiptAuthority") || row.receiptAuthority === "runtime";
    const value = row[condition.column.split(".").at(-1)!];
    return condition.op === "in" ? condition.values.includes(value) : value === condition.value;
  }
  const store = {
    select: (selection: Row) => ({ from: (table: { name: string }) => ({ where: (condition: Condition) => {
      fixture.calls++; if (fixture.fail) throw Error("SELECT private SQL postgres://secret");
      const rows = (fixture.rows[table.name] ?? []).filter(row => match(row, condition)).map(row => Object.fromEntries(Object.keys(selection).map(key => [key, row[key]])));
      const query = { orderBy: (..._args: unknown[]) => query, limit: async (limit: number) => rows.slice(0, limit), for: async () => rows };
      return query;
    } }) }),
    insert: () => { fixture.writes++; throw Error("Inspection must be read-only"); },
    update: () => { fixture.writes++; throw Error("Inspection must be read-only"); },
    delete: () => { fixture.writes++; throw Error("Inspection must be read-only"); },
  };
  return { db: { ...store, transaction: async <T>(work: (database: typeof store) => Promise<T>) => work(store) } };
});
import { GET } from "@/app/api/memory/continuity/route";
const owner = "11111111-1111-4111-8111-111111111111", work = "22222222-2222-4222-8222-222222222222";
const foreignWork = "33333333-3333-4333-8333-333333333333", loop = "44444444-4444-4444-8444-444444444444";
const request = (query = "") => GET(new Request(`http://localhost/api/memory/continuity${query ? `?${query}` : ""}`));
const event = (type: string, status: string, patch: Row = {}): Row => ({ id: "55555555-5555-4555-8555-555555555555",
  workshopId: work, runId: "66666666-6666-4666-8666-666666666666", loopId: null, loopRunId: null,
  createdAt: "2026-10-20T00:00:00Z", type, status, receiptAuthority: "runtime", schemaVersion: "host-working-memory.v1",
  body: "PRIVATE_OLD_SUMMARY", state: { facts: "PRIVATE_OLD_FACT" }, ...patch });
beforeEach(() => {
  vi.stubEnv("TAURI_MODE", "false"); vi.stubEnv("IS_TAURI", "false");
  fixture.authenticated = true; fixture.lease = false; fixture.calls = fixture.writes = 0; fixture.fail = false;
  fixture.rows = { workshops: [{ id: work, name: "Owned Work", userId: owner }, { id: foreignWork, name: "Foreign Work", userId: foreignWork }],
    loops: [{ id: loop, workshopId: foreignWork, userId: foreignWork }], events: [] };
});
describe("owner continuity inspection actual read adapter", () => {
  it("rejects unauthenticated, injected, malformed and Work-capability requests before storage", async () => {
    fixture.authenticated = false; expect((await request()).status).toBe(401); fixture.authenticated = true;
    for (const query of [`owner=${foreignWork}`, `loopId=${loop}`, `workshopId=invalid`, `workshopId=${work}&workshopId=${foreignWork}`]) expect((await request(query)).status).toBe(400);
    fixture.lease = true; expect((await request(`workshopId=${work}`)).status).toBe(403); expect(fixture.calls).toBe(0);
  });
  it("enforces owner and Work/Loop scope using real adapter predicates and performs no writes", async () => {
    const directory = await (await request()).json(); expect(directory.works).toEqual([{ id: work, name: "Owned Work" }]);
    expect(directory.coverage).toMatchObject({ bounded: true, complete: false });
    expect((await request(`workshopId=${foreignWork}`)).status).toBe(404);
    expect((await request(`workshopId=${work}&loopId=${loop}`)).status).toBe(404);
    const data = await (await request(`workshopId=${work}`)).json(); expect(data.status).toBe("unobserved");
    expect(data.receipts).toEqual([]); expect(fixture.writes).toBe(0);
    fixture.fail = true; const failure = await request(`workshopId=${work}`); expect(failure.status).toBe(503);
    expect(await failure.text()).not.toMatch(/SELECT|private|postgres|secret/);
  });
  it("separates saved, prepared and usage receipts, excludes agent claims and never emits historical prose", async () => {
    fixture.rows.events = [event("working_memory_updated", "ready_for_projection", { receiptAuthority: "agent" }),
      event("working_memory_projected", "provider_request_prepared")];
    const projectionOnly = await (await request(`workshopId=${work}`)).json(); expect(projectionOnly.status).toBe("unobserved");
    expect(projectionOnly.receipts).toHaveLength(1); expect(projectionOnly.receipts[0]).toMatchObject({ stage: "prepared-for-request", status: "prepared" });
    fixture.rows.events.push(event("working_memory_updated", "ready_for_projection"),
      event("working_memory_usage", "provider_result_received", { usageSource: "sdk_result", usageStatus: "reported" }));
    const data = await (await request(`workshopId=${work}`)).json(); expect(data.status).toBe("observed");
    expect(data.receipts.map((row: { stage: string }) => row.stage)).toEqual(["prepared-for-request", "saved", "usage-observed"]);
    expect(JSON.stringify(data)).not.toMatch(/PRIVATE_OLD|facts|checkpoint|healthy/); expect(fixture.writes).toBe(0);
  });
});
