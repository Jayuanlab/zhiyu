import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { InteractionScenarioSnapshotDraft } from "@/lib/interactions/scenarios";
const fixture = vi.hoisted(() => ({ rows: [] as any[], calls: [] as string[], conditions: [] as any[],
  sourceOwner: "11111111-1111-4111-8111-111111111111", insertError: false, held: false, readOnly: false,
  gates: new Map<string, Promise<void>>() }));
vi.mock("@/lib/db/client", () => ({ db: { select: (...args: unknown[]) => store.select(...args) } }));
vi.mock("@/lib/memory/revision/transaction", () => ({ withBrainRecordWrite: async (_user: string, kind: string, write: any) => {
  fixture.calls.push(`transaction:${kind}`); const saved = [...fixture.rows];
  const session = { ...store, release: undefined as (() => void) | undefined };
  try { return (await write(session)).result; } catch (error) { fixture.rows = saved; throw error; }
  finally { fixture.held = false; session.release?.(); }
} }));
vi.mock("@/lib/memory/kernel/locks", () => ({ acquireMemoryWriteAdvisoryLock: async (_store: unknown, key: string) => {
  fixture.calls.push("lock"); expect(JSON.parse(key)[0]).toBe("interaction-scenario-state.v1");
  const prior = fixture.gates.get(key) ?? Promise.resolve(); let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }); fixture.gates.set(key, prior.then(() => held));
  await prior; (_store as any).release = release; fixture.held = true;
} }));
import { brainStateSnapshots } from "@/lib/db/schema";
import { persistInteractionScenarioState } from "@/lib/interactions/scenario-state-store";
import { readCurrentScenario } from "@/lib/memory/records/scenarios";
const userId = "11111111-1111-4111-8111-111111111111";
const otherUser = "22222222-2222-4222-8222-222222222222";
const eventId = "33333333-3333-4333-8333-333333333333";
const memoryId = "44444444-4444-4444-8444-444444444444";
const store: any = {
  select: () => ({ from: (table: unknown) => ({ where: (condition: any) => {
    if (!fixture.readOnly) expect(fixture.held).toBe(true); fixture.calls.push("read");
    const query = new PgDialect().sqlToQuery(condition); fixture.conditions.push(query);
    const params = query.params;
    const rows = table === brainStateSnapshots ? fixture.rows.filter(row => row.userId === params[0] && row.scopeType === params[1]
      && row.scopeId === null && row.snapshotType === params[2] && row.metadata.scenarioType === params[3] && row.metadata.scenarioKey.trim().normalize("NFKC").toLowerCase() === params[4]
      && (params.length < 6 || row.metadata.batchHash === params[5]))
      .sort((a, b) => (b.metadata.revision ?? 0) - (a.metadata.revision ?? 0))
      : params[0] === fixture.sourceOwner ? params.slice(1).map(id => ({ id, messageTime: new Date("2026-10-20T00:00:00.000Z") })) : [];
    return { orderBy: () => ({ limit: async (limit: number) => { expect(limit).toBe(1); return rows.slice(0, limit); } }),
      limit: async (limit: number) => rows.slice(0, limit), for: async () => rows };
  } }) }),
  insert: () => ({ values: (value: any) => ({ returning: async () => {
    fixture.calls.push("insert"); if (fixture.insertError) throw new Error("injected persistence failure");
    fixture.rows.push(value); return [value];
  } }) }),
};
function draft(id = "task-a", key = "alpha"): InteractionScenarioSnapshotDraft {
  const task = { id, title: id, status: "candidate", sourceEventIds: [eventId] };
  return { scenarioType: "project", scenarioKey: key, title: key, sourceItemIds: [id], sourceEventIds: [eventId], sourceMemoryIds: [memoryId],
    content: { interfaceVersion: "wechat-scenario-state.v1", scenarioType: "project", scenarioKey: key, title: key,
      summary: id, currentState: id, openLoops: [task], taskUpdates: [task], notes: [], memories: [], sourceEventIds: [eventId] },
    metadata: { observedAt: "2026-10-20T01:00:00.000Z", scenarioType: "project", scenarioKey: key } };
}
beforeEach(() => { fixture.rows = []; fixture.calls = []; fixture.conditions = []; fixture.sourceOwner = userId; fixture.insertError = false; fixture.held = false; fixture.readOnly = false; fixture.gates.clear(); });

describe("scenario state transactional persistence (isolated test double, not PostgreSQL)", () => {
  it("acquires its lineage lock before reads and appends from the exact owner and typed scenario", async () => {
    await persistInteractionScenarioState({ userId, draft: draft() });
    const unrelated = { ...fixture.rows[0], id: "other", userId: otherUser, metadata: { ...fixture.rows[0].metadata, revision: 999 } };
    fixture.rows.push(unrelated);
    const second = await persistInteractionScenarioState({ userId, draft: draft("task-b") });
    expect(fixture.calls.slice(0, 3)).toEqual(["transaction:snapshot", "lock", "read"]);
    expect((second.content.openLoops as any[]).map(item => item.id)).toEqual(["task-a", "task-b"]);
    expect(second.content.revision).toBe(2);
    expect(fixture.conditions[0].params).toEqual([userId, "global", "wechat_scenario_state", "project", "alpha"]);
    expect(fixture.conditions[0].sql).toContain('"scope_id" is null');
  });
  it("replaying an old batch after a new batch returns current state without a new version", async () => {
    await persistInteractionScenarioState({ userId, draft: draft() });
    const second = await persistInteractionScenarioState({ userId, draft: draft("task-b") });
    const replay = await persistInteractionScenarioState({ userId, draft: draft() });
    expect(replay.id).toBe(second.id); expect(fixture.rows).toHaveLength(2);
    expect(replay.content.openLoops).toHaveLength(2);
  });
  it("serializes competing updates with the same lineage lock in the isolated transaction double", async () => {
    const results = await Promise.all([persistInteractionScenarioState({ userId, draft: draft() }),
      persistInteractionScenarioState({ userId, draft: draft("task-b") })]);
    expect(results.map(result => result.content.revision)).toEqual([1, 2]);
    expect(fixture.rows[1].content.openLoops.map((item: any) => item.id)).toEqual(["task-a", "task-b"]);
    expect(fixture.rows).toHaveLength(2);
  });
  it("does not inherit a different typed scenario sharing the same key", async () => {
    await persistInteractionScenarioState({ userId, draft: draft() });
    fixture.rows[0].metadata.scenarioType = "person";
    const next = await persistInteractionScenarioState({ userId, draft: draft("task-b") });
    expect(next.content.revision).toBe(1); expect(next.content.openLoops).toHaveLength(1);
  });
  it("uses the same locked lineage for legacy case and Unicode-equivalent scene keys", async () => {
    await persistInteractionScenarioState({ userId, draft: draft("task-a", "Ａlpha") });
    fixture.rows[0].metadata.scenarioKey = "Ａlpha"; fixture.rows[0].content.scenarioKey = "Ａlpha";
    const next = await persistInteractionScenarioState({ userId, draft: draft("task-b", "alpha") });
    expect(next.content.scenarioKey).toBe("alpha"); expect(next.content.revision).toBe(2);
    expect(next.content.openLoops).toHaveLength(2);
  });
  it("rejects foreign source references and exposes persistence failures", async () => {
    await expect(persistInteractionScenarioState({ userId: otherUser, draft: draft() })).rejects.toThrow();
    expect(fixture.rows).toHaveLength(0);
    fixture.insertError = true;
    await expect(persistInteractionScenarioState({ userId, draft: draft() })).rejects.toThrow(/persistence failure/);
    expect(fixture.rows).toHaveLength(0);
  });
  it("keeps the previous persisted version when the merged state exceeds capacity", async () => {
    await persistInteractionScenarioState({ userId, draft: draft() });
    const before = structuredClone(fixture.rows);
    const big = draft("big"); big.content.taskUpdates = Array.from({ length: 5_001 }, (_, index) => ({ id: `x${index}`, title: "x", status: "candidate", sourceEventIds: [eventId] }));
    await expect(persistInteractionScenarioState({ userId, draft: big })).rejects.toThrow(/capacity/);
    expect(fixture.rows).toEqual(before);
  });
  it("reads exact current state even behind more than a hundred unrelated newer rows", async () => {
    const expected = await persistInteractionScenarioState({ userId, draft: draft() });
    const own = fixture.rows[0];
    fixture.rows.push(...Array.from({ length: 150 }, (_, index) => ({ ...own, id: `noise-${index}`,
      metadata: { ...own.metadata, scenarioKey: `other-${index}`, revision: 999 } })));
    fixture.readOnly = true; fixture.conditions = [];
    const current = await readCurrentScenario({ userId, scenarioType: "project", scenarioKey: " ＡLPHA " });
    expect(current?.id).toBe(expected.id);
    expect(fixture.conditions).toHaveLength(1);
    expect(fixture.conditions[0].params).toEqual([userId, "global", "wechat_scenario_state", "project", "alpha"]);
    expect(await readCurrentScenario({ userId: otherUser, scenarioType: "project", scenarioKey: "alpha" })).toBeNull();
    expect(await readCurrentScenario({ userId, scenarioType: "person", scenarioKey: "alpha" })).toBeNull();
  });
});
