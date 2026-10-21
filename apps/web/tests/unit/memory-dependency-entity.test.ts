import { describe, expect, it } from "vitest";
import { authorizeMemoryDependencyEntity } from "@/lib/memory/revision/dependencies-entity";
import { withExecutionContext } from "@/lib/work-runtime/execution-context";
const userId = "00000000-0000-4000-8000-000000000001", workId = "00000000-0000-4000-8000-000000000002";
const id = "00000000-0000-4000-8000-000000000003";
function value(kind: "wiki_note" | "interaction_task" | "loop" = "interaction_task") {
  return { entity: { kind, id, title: "Synthetic domain row", content: "Synthetic body", contentTruncated: false,
    status: "candidate", version: `bmde1:${"a".repeat(64)}`, workId }, row: { id, userId } };
}
const requester = { type: "work" as const, userId, id: workId };
const lease = { userId, workshopId: workId, runId: "00000000-0000-4000-8000-000000000004", workerId: "synthetic-worker", token: 7 };
describe("Memory dependency target ownership", () => {
  it("rejects foreign owners before human owner review or Work checks", () => {
    expect(() => authorizeMemoryDependencyEntity({ type: "chat", userId: "foreign", id: "human" }, value())).toThrow();
    expect(() => authorizeMemoryDependencyEntity({ ...requester, userId: "foreign" }, value())).toThrow();
  });
  it("permits authenticated human inspection but never treats the model requester as human", () => {
    expect(() => authorizeMemoryDependencyEntity({ type: "chat", userId, id: "human" }, value())).not.toThrow();
    expect(() => authorizeMemoryDependencyEntity({ type: "chat", userId, id: "brain-mcp" }, value())).toThrow();
  });
  it("does not let another Work capture a Loop or a metadata-owned task", async () => {
    for (const kind of ["wiki_note", "interaction_task", "loop"] as const)
      expect(() => authorizeMemoryDependencyEntity({ ...requester, id: id }, value(kind), true)).toThrow();
    await withExecutionContext({ ...lease, workshopId: id }, async () => {
      expect(() => authorizeMemoryDependencyEntity(requester, value(), true)).toThrow();
    });
  });
  it("requires a matching server context to capture notes/tasks with only metadata Work identity", async () => {
    for (const kind of ["wiki_note", "interaction_task"] as const) {
      expect(() => authorizeMemoryDependencyEntity(requester, value(kind), true)).toThrow();
      await withExecutionContext(lease, async () => {
        expect(() => authorizeMemoryDependencyEntity(requester, value(kind), true)).not.toThrow();
      });
    }
    // The host transaction independently validates the DB run/token/expiry;
    // this predicate only establishes the required server context and target owner.
    expect(() => authorizeMemoryDependencyEntity(requester, value("loop"), true)).not.toThrow();
  });
});
