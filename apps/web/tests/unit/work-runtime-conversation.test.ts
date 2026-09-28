import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const mocks = vi.hoisted(() => ({ select: vi.fn(), execute: vi.fn(), getWorkshop: vi.fn(),
  startWorkRun: vi.fn(), getWorkCommand: vi.fn(), parseFiles: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ db: { select: mocks.select, execute: mocks.execute } }));
vi.mock("@/lib/db/schema", async () => {
  const { pgTable, uuid, jsonb, timestamp } = await import("drizzle-orm/pg-core");
  return { workshopRuns: pgTable("workshop_runs", { id: uuid("id"), workshopId: uuid("workshop_id"),
    triggerReason: jsonb("trigger_reason"), createdAt: timestamp("created_at") }) };
});
vi.mock("@/lib/workshops/service", () => ({ getWorkshop: mocks.getWorkshop }));
vi.mock("@/lib/work-runtime/commands", () => ({ startWorkRun: mocks.startWorkRun }));
vi.mock("@/lib/workshops/conversation-input", () => ({ parseConversationInputFiles: mocks.parseFiles }));
vi.mock("@/lib/work-runtime/command-ledger", () => ({
  getWorkCommand: mocks.getWorkCommand,
  WorkCommandConflict: class extends Error {
    constructor(public code: string) { super(code); }
    get status() { return this.code === "not_found" ? 404 : 409; }
  },
}));

import { listWorkConversation, submitWorkConversation, WorkConversationValidationError } from "@/lib/work-runtime/conversation";
import { WorkCommandConflict } from "@/lib/work-runtime/command-ledger";

const workId = "b0252cc6-8e80-45fa-b125-ead5618bc4ad";
const userId = "13d59c04-24a6-4cc9-b760-f50eb4b8a333";
const commandId = "489d7ffa-d4ee-4e9b-8d01-3db8bc1fc943";
const runId = "a42df8b8-0c8d-84be-ad84-ef2b70153af0";
const parentRunId = "154dbfcc-26ac-477b-b00c-5a67ed496463";
const path = "D:\\docs\\本次文档.pdf";
const run = { id: runId, workshopId: workId, status: "queued", createdAt: new Date("2026-09-26T00:00:00Z"),
  updatedAt: new Date("2026-09-26T00:00:00Z"), triggerReason: { type: "conversation", content: "处理文档",
    parentRunId: null, inputFiles: [path], commandMeta: { commandId } } };
const dialect = new PgDialect();
const selections: Array<{ where: string; limit: number }> = [];
function selection(rows: unknown[]) {
  let where = "";
  const chain = { from: vi.fn(() => chain), where: vi.fn((value) => {
    where = dialect.sqlToQuery(value).sql; return chain;
  }), orderBy: vi.fn(() => chain), limit: vi.fn(async (limit) => { selections.push({ where, limit }); return rows; }) };
  return chain;
}

describe("Work conversation runtime boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selections.length = 0;
    mocks.getWorkshop.mockResolvedValue({ id: workId, status: "active" });
    mocks.getWorkCommand.mockResolvedValue(null);
    mocks.execute.mockResolvedValue([]);
    mocks.select.mockImplementation(() => selection([run]));
    mocks.parseFiles.mockReturnValue([path]);
    mocks.startWorkRun.mockResolvedValue({ run });
  });

  it("denies another owner's Work before querying its conversation", async () => {
    mocks.getWorkshop.mockResolvedValue(null);
    await expect(listWorkConversation({ userId, workId })).rejects.toMatchObject({ code: "not_found" });
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
    await expect(submitWorkConversation({ userId, workId, commandId, content: "处理文档" }))
      .rejects.toMatchObject({ code: "not_found" });
    expect(mocks.startWorkRun).not.toHaveBeenCalled();
  });

  it("filters conversation before limiting and bounds events per turn in one query", async () => {
    mocks.select.mockReturnValue(selection(Array.from({ length: 31 }, (_, index) => ({ ...run,
      id: `${index}`.padStart(8, "0") + "-0000-0000-0000-000000000000" }))));
    const result = await listWorkConversation({ userId, workId });
    expect(result.turns).toHaveLength(30);
    expect(result.hasMore).toBe(true);
    expect(result.turns[0].id).toBe("00000029-0000-0000-0000-000000000000");
    expect(selections).toEqual([{ where: expect.stringContaining("->>'type' = 'conversation'"), limit: 31 }]);
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    const query = dialect.sqlToQuery(mocks.execute.mock.calls[0][0]);
    expect(query.sql).toContain("CROSS JOIN LATERAL");
    expect(query.params).toContain(301);
    expect(query.params).toContain(workId);
  });

  it("rejects a parent outside this Work or a non-conversation run before queueing", async () => {
    mocks.select.mockReturnValue(selection([]));
    await expect(submitWorkConversation({ userId, workId, commandId, content: "继续", parentRunId }))
      .rejects.toBeInstanceOf(WorkConversationValidationError);
    expect(selections[0].where).toContain('"workshop_runs"."workshop_id"');
    expect(selections[0].where).toContain("->>'type' = 'conversation'");
    expect(mocks.startWorkRun).not.toHaveBeenCalled();
  });

  it("queues a temporary trigger through the existing ledger and recovers current state on retry", async () => {
    mocks.select.mockReturnValueOnce(selection([run])).mockReturnValueOnce(selection([{ ...run, status: "completed" }]));
    const input = { userId, workId, commandId, content: "  处理文档  " };
    expect((await submitWorkConversation(input)).turn.status).toBe("queued");
    expect((await submitWorkConversation(input)).turn.status).toBe("completed");
    expect(mocks.startWorkRun.mock.calls[0][0]).toEqual(mocks.startWorkRun.mock.calls[1][0]);
    expect(mocks.startWorkRun).toHaveBeenCalledWith({ userId, workId, commandId, source: "owner",
      reason: "Temporary task submitted in Work conversation.",
      triggerReason: { type: "conversation", content: "处理文档", parentRunId: null, inputFiles: [path] } });
  });

  it("lets the ledger reject changed content under an already-used commandId", async () => {
    mocks.startWorkRun.mockRejectedValue(new WorkCommandConflict("payload_conflict"));
    await expect(submitWorkConversation({ userId, workId, commandId, content: "改做另一件事" }))
      .rejects.toMatchObject({ code: "payload_conflict" });
  });

  it("rejects new tasks while paused but recovers an accepted task after pause", async () => {
    mocks.getWorkshop.mockResolvedValue({ id: workId, status: "paused" });
    await expect(submitWorkConversation({ userId, workId, commandId, content: "处理文档" }))
      .rejects.toMatchObject({ code: "target_busy" });
    expect(mocks.startWorkRun).not.toHaveBeenCalled();
    mocks.getWorkCommand.mockResolvedValue({ commandId, status: "succeeded" });
    expect((await submitWorkConversation({ userId, workId, commandId, content: "处理文档" })).turn.id).toBe(runId);
  });

  it("validates body and parser errors without accepting any task", async () => {
    for (const patch of [{ commandId: "bad" }, { content: [] }, { content: "x".repeat(12001) }, { parentRunId: {} }]) {
      await expect(submitWorkConversation({ userId, workId, commandId, content: "任务", ...patch }))
        .rejects.toBeInstanceOf(WorkConversationValidationError);
    }
    mocks.parseFiles.mockImplementation(() => { throw new Error("最多 20 个文件"); });
    await expect(submitWorkConversation({ userId, workId, commandId, content: "处理文件" }))
      .rejects.toThrow("最多 20 个文件");
    expect(mocks.startWorkRun).not.toHaveBeenCalled();
  });
});
