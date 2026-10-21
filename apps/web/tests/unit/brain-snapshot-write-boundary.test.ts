import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

const f = vi.hoisted(() => ({
  handlers: new Map<string, (input: unknown) => Promise<unknown>>(),
  insert: vi.fn(async (snapshot: Record<string, unknown>) => ({ id: "snapshot-1", createdAt: "2026-10-20T00:00:00Z", ...snapshot })),
}));

// Replace only SDK registration/transport. Validate the registered schema and
// invoke the production handler; the Brain service and its guard remain real.
vi.mock("@anthropic-ai/claude-agent-sdk", async () => {
  const { z } = await import("zod");
  return { tool: (name: string, _description: string, schema: Parameters<typeof z.object>[0], handler: (args: Record<string, unknown>) => Promise<unknown>) => {
    f.handlers.set(name, args => handler(z.object(schema).parse(args)));
    return { name };
  } };
});
vi.mock("@/lib/db/client", () => ({ db: { transaction: async <T>(work: (store: object) => Promise<T>) => work({}) } }));
vi.mock("@/lib/memory/adapters/postgres/state-snapshots", () => ({
  insertStateSnapshotInTransaction: async (_store: unknown, input: Record<string, unknown>) => f.insert(input),
  listBrainStateSnapshots: vi.fn(), catalogBrainStateSnapshots: vi.fn(),
}));

import { createBrainTools } from "@/lib/ai/mcp/tools/brain";

const session: Session = { user: { id: "owner-1", type: "regular" }, expires: "2027-01-01T00:00:00Z" };
function registeredSnapshotWriter() {
  createBrainTools(session);
  const handler = f.handlers.get("brainWriteSnapshot");
  expect(handler).toBeDefined();
  return handler!;
}
beforeEach(() => { f.handlers.clear(); f.insert.mockClear(); });

describe("registered brainWriteSnapshot authority boundary", () => {
  it.each([{ type: "global" }, { type: "work", workId: "work-1" }])("rejects forged current scenario state in %j before repository persistence", async scope => {
    const write = registeredSnapshotWriter();
    await expect(write({ scope, snapshotType: "wechat_scenario_state",
      content: { scenarioType: "project", scenarioKey: "project-a", status: "done", version: 999,
        taskUpdates: [{ id: "task-a", stateAuthority: "business_task_record", stateRevision: 999 }] },
      metadata: { projectionOrigin: "interaction_task_state_transition", authority: "interaction_task_domain" },
    })).rejects.toMatchObject({ code: "reserved_scenario_snapshot", status: 400 });
    expect(f.insert).not.toHaveBeenCalled();
  });

  it("still writes a normal work_state through the same tool, service and repository seam", async () => {
    const write = registeredSnapshotWriter();
    const result = await write({ scope: { type: "work", workId: "work-1" }, snapshotType: "work_state",
      content: { phase: "researching", openQuestions: ["Verify current evidence"] }, metadata: { source: "model_status_estimate" },
    });
    expect(f.insert).toHaveBeenCalledExactlyOnceWith({ userId: "owner-1", scope: { type: "work", workId: "work-1" },
      snapshotType: "work_state", content: { phase: "researching", openQuestions: ["Verify current evidence"] },
      metadata: { source: "model_status_estimate" }, sourceMemoryIds: [],
    });
    expect(result).toMatchObject({ data: { snapshot: { id: "snapshot-1", userId: "owner-1", snapshotType: "work_state" } } });
  });
});
