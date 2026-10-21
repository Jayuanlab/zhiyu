import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { BrainAccessGrant, BrainMemory } from "@/lib/memory/kernel/memory-types";
import type { ObservationRecord } from "@/lib/memory/contracts";
import type { StateSnapshotRecord } from "@/lib/memory/records/state-snapshots";
import type { AgentMessage } from "@openzhiyu/ai/agent/types";
import { createPiAgentRuntime } from "@openzhiyu/ai/agent/runtime";
import { Type } from "@earendil-works/pi-ai";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

const fixture = vi.hoisted(() => ({ memories: [] as BrainMemory[], grants: [] as BrainAccessGrant[],
  observations: [] as ObservationRecord[], snapshots: [] as StateSnapshotRecord[], receipts: [] as unknown[],
  auditFailure: false, grantFailure: false, scenarioKeys: ["project:alpha"] }));
vi.mock("@/lib/memory/adapters/postgres/exact-published-sources", () => ({ readExactPublishedRowsForShare: async (_store: unknown, { source }: { source: string }) =>
  source === "brainObservations" ? structuredClone(fixture.observations) : source === "brainStateSnapshots" ? structuredClone(fixture.snapshots) : structuredClone(fixture.memories),
  readExactWorkBindingForShare: async () => ({ sourceFilters: { scenarioKeys: fixture.scenarioKeys } }),
}));
vi.mock("@/lib/db/client", () => {
  async function transaction<T>(work: (store: never) => Promise<T>): Promise<T> {
    const before = fixture.receipts.length;
    try { return await work({} as never); } catch (error) { fixture.receipts.length = before; throw error; }
  }
  return { db: { transaction }, withDatabaseTransaction: transaction };
});
vi.mock("@/lib/memory/adapters/postgres/memory-records", () => ({
  getBrainMemoryById: async ({ userId, memoryId }: { userId: string; memoryId: string }) => structuredClone(fixture.memories.find(row => row.userId === userId && row.id === memoryId) ?? null),
  listBrainAccessGrantsForUser: async () => { if (fixture.grantFailure) throw Error("private SQL error"); return structuredClone(fixture.grants); },
  readContextMemoriesForShare: async (_store: unknown, userId: string, ids: string[]) => structuredClone(fixture.memories.filter(row => row.userId === userId && ids.includes(row.id))),
  readContextGrantsForShare: async () => { if (fixture.grantFailure) throw Error("private SQL error"); return structuredClone(fixture.grants); },
}));
vi.mock("@/lib/memory/adapters/postgres/observations", () => ({ readObservation: async (_store: unknown, userId: string, id: string) =>
  structuredClone(fixture.observations.find(row => row.userId === userId && row.id === id) ?? null) }));
vi.mock("@/lib/memory/adapters/postgres/evidence-sources", () => ({ postgresEvidenceSources: {
  readObservations: async ({ userId, ids }: { userId: string; ids: string[] }) => structuredClone(fixture.observations.filter(row => row.userId === userId && ids.includes(row.id))),
} }));
vi.mock("@/lib/memory/adapters/postgres/state-snapshots", () => ({
  readStateSnapshotInTransaction: async (_store: unknown, input: { userId: string; snapshotId: string; workId?: string }) => structuredClone(fixture.snapshots.find(row => row.userId === input.userId && row.id === input.snapshotId
    && (!input.workId || (row.scope.type === "work" && row.scope.workId === input.workId || row.scope.type === "workshop" && row.scope.workshopId === input.workId))) ?? null),
  listBrainStateSnapshots: async ({ userId, snapshotId }: { userId: string; snapshotId?: string }) => structuredClone(fixture.snapshots.filter(row => row.userId === userId && (!snapshotId || row.id === snapshotId))),
  catalogBrainStateSnapshots: vi.fn(),
}));
vi.mock("@/lib/memory/adapters/postgres/context-logs", () => ({ lockContextOwnerForShare: vi.fn(),
  insertContextLogInTransaction: async (_store: unknown, input: unknown) => {
    if (fixture.auditFailure) throw Error("private receipt SQL error");
    fixture.receipts.push(structuredClone(input)); return { id: `receipt-${fixture.receipts.length}` };
  } }));
vi.mock("@/lib/workshops/service", () => ({ getWorkshopMemory: async () => null, getWorkshopEvent: async () => null }));
vi.mock("@/lib/interactions/service", () => ({ getInteractionEventsByIds: async () => [] }));

import { readWorkshopMemoryEvidence } from "@/lib/workshops/memory-evidence-reader";
import { listBrainMemoriesForUser, listBrainSnapshotsForUser } from "@/lib/ai/brain-read-tools";
import { withMemoryDispatchContext, bindMemoryDispatchRuntime, assertMemoryDispatchCurrent, registerContextForDispatch, registerExactUseForDispatch } from "@/lib/memory/context/dispatch";
import { admitExactUse, exactProofVersions } from "@/lib/memory/context/exact-use-admission";
import { verifyExactMemoryRefsForDispatch, admitExactPublishedRecordUse, withExactUseReaderPolicy } from "@/lib/memory/context/exact-use";
import { getBrainMemoryRevisionVersion } from "@/lib/memory/revision/version";

const userId = "11111111-1111-4111-8111-111111111111", workId = "22222222-2222-4222-8222-222222222222";
const memoryId = "33333333-3333-4333-8333-333333333333", observationId = "44444444-4444-4444-8444-444444444444";
const snapshotId = "55555555-5555-4555-8555-555555555555", otherWork = "66666666-6666-4666-8666-666666666666";
const workshop = { id: workId, userId, modelConfig: { memoryApplicability: { schemaVersion: "memory-applicability.v1", scenarioKeys: ["project:alpha"] } } };
const read = () => readWorkshopMemoryEvidence({ workshop, memoryId });
function bind() { bindMemoryDispatchRuntime({ engine: "pi", adapter: "pi-agent-harness" }); }
async function run(work: () => Promise<void>) { return withMemoryDispatchContext(async () => { bind(); await work(); }); }
beforeEach(() => {
  fixture.auditFailure = fixture.grantFailure = false; fixture.receipts = []; fixture.grants = []; fixture.scenarioKeys = ["project:alpha"];
  fixture.memories = [{ id: memoryId, userId, scope: { type: "work", workId }, ownerType: "work", ownerId: workId,
    memoryType: "fact", subject: "source", content: "PRIVATE_CANONICAL_BODY", status: "verified", confidence: 50,
    evidenceRefs: [`brain-observation:${observationId}`], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    metadata: { facets: { scenarioKeys: ["project:alpha"], scenarioApplicability: "scoped" } } }];
  fixture.observations = [{ id: observationId, userId, sourceType: "owner_memory_revision", sourceId: "owner-command",
    content: "PRIVATE_OBSERVATION_BODY", contentHash: createHash("sha256").update("PRIVATE_OBSERVATION_BODY").digest("hex"),
    trustLevel: "owner_assertion", metadata: { memoryId }, observedAt: "2026-01-01T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z" }];
  fixture.snapshots = [{ id: snapshotId, userId, scope: { type: "work", workId }, snapshotType: "work_state",
    content: { state: "PRIVATE_SNAPSHOT_BODY" }, sourceMemoryIds: [memoryId], metadata: {}, createdAt: "2026-01-01T00:00:00.000Z" }];
});

describe("independently read model sources", () => {
  it("admits actual Work canonical and typed observation rows without a preceding recall", async () => {
    await run(async () => {
      const result = await read(); expect(result.status).toBe("read");
      expect(JSON.stringify(result)).toContain("PRIVATE_OBSERVATION_BODY");
      await assertMemoryDispatchCurrent();
      expect(fixture.receipts.length).toBe(4);
      expect(JSON.stringify(fixture.receipts)).not.toContain("PRIVATE_CANONICAL_BODY");
      expect(JSON.stringify(fixture.receipts)).not.toContain("PRIVATE_OBSERVATION_BODY");
      expect(JSON.stringify(fixture.receipts)).toContain("obsrv1:");
    });
  });
  it.each(["revision", "expiry", "status", "observation", "audit", "lookup", "binding"])("blocks the next request on %s and rolls back its audit batch", async change => {
    await run(async () => {
      expect((await read()).status).toBe("read"); await assertMemoryDispatchCurrent();
      const count = fixture.receipts.length;
      if (change === "revision") fixture.memories[0]!.content = "corrected";
      if (change === "expiry") fixture.memories[0]!.expiresAt = "2000-01-01T00:00:00Z";
      if (change === "status") fixture.memories[0]!.status = "candidate";
      if (change === "observation") fixture.observations[0]!.content = "changed raw observation";
      if (change === "audit") fixture.auditFailure = true;
      if (change === "lookup") fixture.grantFailure = true;
      if (change === "binding") fixture.scenarioKeys = ["project:beta"];
      await expect(assertMemoryDispatchCurrent()).rejects.toMatchObject({ code: "memory_dispatch_context_unavailable" });
      expect(fixture.receipts).toHaveLength(count);
      await expect(assertMemoryDispatchCurrent()).rejects.toMatchObject({ code: "memory_dispatch_context_unavailable" });
    });
  });
  it("rechecks an independently granted source and never turns lookup failure into a broader owner read", async () => {
    fixture.memories[0]!.ownerId = otherWork; fixture.memories[0]!.scope = { type: "work", workId: otherWork };
    fixture.grants = [{ id: "grant", userId, subjectType: "work", subjectId: workId, scope: { type: "work", workId: otherWork }, permissions: ["reference"] }];
    await run(async () => {
      expect((await read()).status).toBe("read"); await assertMemoryDispatchCurrent(); fixture.grants = [];
      await expect(assertMemoryDispatchCurrent()).rejects.toMatchObject({ code: "memory_dispatch_context_unavailable" });
    });
    fixture.grantFailure = true;
    await run(async () => { const result = await read(); expect(result.status).toBe("unavailable"); expect(JSON.stringify(result)).not.toContain("PRIVATE_CANONICAL_BODY"); });
  });
  it("withholds a different scenario, initially deleted sources and unsupported runtimes before returning body", async () => {
    await run(async () => {
      fixture.memories[0]!.metadata = { facets: { scenarioKeys: ["project:beta"], scenarioApplicability: "scoped" } };
      const result = await read(); expect(result.status).toBe("unavailable"); expect(JSON.stringify(result)).not.toContain("PRIVATE_");
    });
    fixture.memories[0]!.status = "deleted";
    await run(async () => { expect((await read()).status).toBe("unavailable"); });
    await withMemoryDispatchContext(async () => {
      bindMemoryDispatchRuntime({ engine: "claude", adapter: "claude-agent-sdk" });
      const result = await listBrainMemoriesForUser({ userId, listMemories: async () => fixture.memories });
      expect(result.ok).toBe(false); expect(result.text).not.toContain("PRIVATE_CANONICAL_BODY");
    });
  });
  it("registers Chat full canonical lists and exact snapshot windows with real stored versions", async () => {
    await run(async () => {
      expect((await listBrainMemoriesForUser({ userId, listMemories: async () => structuredClone(fixture.memories) })).ok).toBe(true);
      expect((await listBrainSnapshotsForUser({ userId, snapshotId })).ok).toBe(true);
      await assertMemoryDispatchCurrent(); fixture.snapshots[0]!.content.state = "corrected";
      await expect(assertMemoryDispatchCurrent()).rejects.toMatchObject({ code: "memory_dispatch_context_unavailable" });
    });
  });
  it("permits historical authorized rows but never upgrades a candidate proof after approval", async () => {
    fixture.memories[0]!.status = "superseded";
    await run(async () => { expect((await read()).status).toBe("read"); await assertMemoryDispatchCurrent(); });
    fixture.memories[0]!.status = "candidate";
    await run(async () => {
      expect((await read()).status).toBe("read"); await assertMemoryDispatchCurrent(); fixture.memories[0]!.status = "active";
      await expect(assertMemoryDispatchCurrent()).rejects.toMatchObject({ code: "memory_dispatch_context_unavailable" });
    });
  });
  it("does not accept invented projections, mutable proofs or verification outside a model run", async () => {
    await expect(admitExactUse({ requester: { type: "chat", userId }, accessMode: "owner_override", purpose: "fixture",
      memories: [{ ...fixture.memories[0]!, content: "invented" }] })).rejects.toMatchObject({ code: "memory_exact_use_unavailable" });
    const proof = await admitExactUse({ requester: { type: "chat", userId }, accessMode: "owner_override", purpose: "fixture", memories: fixture.memories });
    expect(Object.isFrozen(proof.policy.requester)).toBe(true); expect(Object.isFrozen(proof.refs[0])).toBe(true);
    expect(() => exactProofVersions(structuredClone(proof))).toThrow();
    await expect(verifyExactMemoryRefsForDispatch({ requester: { type: "chat", userId }, purpose: "continuity", refs: [] })).rejects.toMatchObject({ code: "memory_exact_use_unavailable" });
  });
  it("applies one policy cap across actual exact proofs and later context-pack registration", async () => {
    await run(async () => {
      for (let index = 0; index < 64; index++) registerExactUseForDispatch(await admitExactUse({
        requester: { type: "chat", userId }, accessMode: "owner_override", purpose: `actual_exact_policy_${index}`,
        snapshots: fixture.snapshots.map(record => ({ record })),
      }));
      const memory = fixture.memories[0]!;
      expect(() => registerContextForDispatch({ requester: { type: "chat", userId }, accessMode: "owner_override", taskIntent: "another policy",
        pack: { interfaceVersion: "brain-context.v1", items: [{ id: memory.id, revisionVersion: getBrainMemoryRevisionVersion(memory),
          ownerType: memory.ownerType, ownerId: memory.ownerId, memoryType: memory.memoryType, subject: memory.subject,
          content: memory.content, evidenceRefs: memory.evidenceRefs, score: 1, reasons: [] }], denied: [], omitted: [],
          selection: { selectedCount: 1, deniedCount: 0, omittedCount: 0, duplicateCanonicalGroupCount: 0, selectedCanonicalKinds: {} } } })).toThrow("start a fresh context");
      await expect(assertMemoryDispatchCurrent()).rejects.toMatchObject({ code: "memory_dispatch_context_unavailable" });
    });
  });
  it("matches actual published fields, registers independent owner observations, and refuses Work owner projections", async () => {
    await run(async () => {
      await expect(admitExactPublishedRecordUse({ userId, source: "brainMemories", rows: [{ id: memoryId, content: "invented" }] })).rejects.toMatchObject({ code: "memory_exact_use_unavailable" });
      await admitExactPublishedRecordUse({ userId, source: "brainObservations", rows: [{ id: observationId, content: fixture.observations[0]!.content }] });
      await assertMemoryDispatchCurrent(); fixture.observations[0]!.metadata = { changed: true };
      await expect(assertMemoryDispatchCurrent()).rejects.toMatchObject({ code: "memory_dispatch_context_unavailable" });
    });
    await run(async () => {
      await expect(withExactUseReaderPolicy({ requester: { type: "work", userId, id: workId }, purpose: "platform_recall" }, () =>
        admitExactPublishedRecordUse({ userId, source: "brainMemories", rows: [{ id: memoryId, content: fixture.memories[0]!.content }] }))).rejects.toMatchObject({ code: "memory_exact_use_unavailable" });
    });
  });
  it("the actual Pi next logical request cannot send newly revoked exact tool evidence", async () => {
    const faux = createFauxCore({}), stream = vi.fn(async (...args: Parameters<typeof faux.streamSimple>) => faux.streamSimple(...args));
    const runtime = createPiAgentRuntime({ adapter: "harness", model: faux.getModel(), streamFn: stream, tools: [{ name: "exact", label: "exact",
      description: "read an exact memory", parameters: Type.Object({}), replay: "safe", execute: async () => {
        const result = await read(); expect(result.status).toBe("read"); fixture.memories[0]!.content = "corrected after tool response";
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: {} };
      } }] });
    faux.setResponses([fauxAssistantMessage(fauxToolCall("exact", {}), { stopReason: "toolUse" }), fauxAssistantMessage("never requested")]);
    const messages: AgentMessage[] = [];
    await run(async () => { for await (const message of runtime.run({ operation: "run", prompt: "read exact", options: { onBeforeProviderRequest: assertMemoryDispatchCurrent } })) messages.push(message); });
    expect(stream).toHaveBeenCalledOnce(); expect(messages.find(row => row.type === "runtime_terminal")?.runtimeTerminal?.status).toBe("failed");
  });
});
