import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const f = vi.hoisted(() => ({
  authenticated: true,
  create: vi.fn(), update: vi.fn(), action: vi.fn(), remove: vi.fn(), clear: vi.fn(), memory: vi.fn(),
}));
vi.mock("@/app/(auth)/auth", () => ({ auth: async () => f.authenticated ? { user: { id: "owner" } } : null }));
vi.mock("@/lib/interactions/service", () => ({
  createInteractionTask: f.create, updateInteractionTaskStatus: f.update, deleteInteractionWikiItem: f.remove,
  clearInteractionWikiItems: f.clear, clearInteractionMemories: vi.fn(), updateInteractionMemoryStatus: f.memory,
  createInteractionBrainMemory: vi.fn(), createInteractionNote: vi.fn(), createInteractionSummaryNoteFromEvents: vi.fn(), listInteractionWiki: vi.fn(),
}));
vi.mock("@/lib/interactions/task-state", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/interactions/task-state")>(), actOnInteractionTask: f.action,
}));

import { POST, PATCH, DELETE } from "@/app/api/interactions/wiki/route";
import { TaskActionConflict, TaskActionInputError } from "@/lib/interactions/task-state";

function request(method: string, body: unknown) {
  return new NextRequest("http://localhost/api/interactions/wiki", {
    method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}
const task = { kind: "task", id: "task-a", status: "done", commandId: "command-a", expectedVersion: 4 };
beforeEach(() => {
  vi.clearAllMocks(); f.authenticated = true;
  for (const write of [f.create, f.update, f.action, f.remove, f.clear, f.memory]) write.mockResolvedValue({ id: "task-a" });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("interaction wiki task command HTTP boundary", () => {
  it.each([["POST", POST], ["PATCH", PATCH], ["DELETE", DELETE]] as const)("rejects unauthenticated %s before a writer", async (method, handler) => {
    f.authenticated = false;
    expect((await handler(request(method, task))).status).toBe(401);
    expect(f.create).not.toHaveBeenCalled(); expect(f.update).not.toHaveBeenCalled(); expect(f.remove).not.toHaveBeenCalled();
  });

  it("passes a required command and the observed revision to the status domain", async () => {
    const response = await PATCH(request("PATCH", { ...task, userId: "foreign", metadata: { taskState: { version: 999 } } }));
    expect(response.status).toBe(200);
    expect(f.update).toHaveBeenCalledExactlyOnceWith({ userId: "owner", id: "task-a", status: "done", commandId: "command-a", expectedVersion: 4 });
  });

  it.each([
    { commandId: undefined }, { commandId: "" }, { commandId: "  " }, { commandId: 42 }, { commandId: "x".repeat(201) },
    { expectedVersion: undefined }, { expectedVersion: -1 }, { expectedVersion: 0.5 }, { expectedVersion: Number.MAX_SAFE_INTEGER + 1 }, { expectedVersion: "4" },
  ])("rejects malformed required status command %j before storage", async patch => {
    expect((await PATCH(request("PATCH", { ...task, ...patch }))).status).toBe(400);
    expect(f.update).not.toHaveBeenCalled(); expect(f.action).not.toHaveBeenCalled();
  });

  it("keeps action PATCH commands mandatory and forwards a real zero revision", async () => {
    expect((await PATCH(request("PATCH", { kind: "task", id: "task-a", action: "completeTask", expectedVersion: 0 }))).status).toBe(400);
    expect(f.action).not.toHaveBeenCalled();
    expect((await PATCH(request("PATCH", { kind: "task", id: "task-a", action: "completeTask", commandId: "action-a", expectedVersion: 0 }))).status).toBe(200);
    expect(f.action).toHaveBeenCalledExactlyOnceWith({ userId: "owner", id: "task-a", action: "completeTask", commandId: "action-a", expectedVersion: 0, at: undefined });
  });

  it("passes optional creation command IDs and rejects invalid supplied IDs", async () => {
    const body = { kind: "task", title: "Follow up", sourceEventIds: ["source-a"], commandId: "create-a" };
    expect((await POST(request("POST", body))).status).toBe(201);
    expect(f.create.mock.calls[0][0]).toMatchObject({ userId: "owner", commandId: "create-a" });
    f.create.mockClear();
    expect((await POST(request("POST", { ...body, commandId: 7 }))).status).toBe(400);
    expect(f.create).not.toHaveBeenCalled();
    expect((await POST(request("POST", { ...body, commandId: undefined }))).status).toBe(201);
  });

  it("validates optional single-delete fields while clear remains a domain-wide command", async () => {
    expect((await DELETE(request("DELETE", task))).status).toBe(200);
    expect(f.remove).toHaveBeenCalledExactlyOnceWith({ userId: "owner", kind: "task", id: "task-a", reason: null, commandId: "command-a", expectedVersion: 4 });
    f.remove.mockClear();
    expect((await DELETE(request("DELETE", { ...task, expectedVersion: -1 }))).status).toBe(400);
    expect((await DELETE(request("DELETE", { ...task, commandId: "" }))).status).toBe(400);
    expect(f.remove).not.toHaveBeenCalled();
    expect((await DELETE(request("DELETE", { kind: "task", id: "task-a" }))).status).toBe(200);
    expect((await DELETE(request("DELETE", { action: "clear_all" }))).status).toBe(200);
    expect(f.clear).toHaveBeenCalledExactlyOnceWith({ userId: "owner", reason: null });
  });

  it("leaves memory status commands independent of task CAS fields", async () => {
    expect((await PATCH(request("PATCH", { kind: "memory", id: "memory-a", status: "confirmed" }))).status).toBe(200);
    expect(f.memory).toHaveBeenCalledExactlyOnceWith({ userId: "owner", id: "memory-a", status: "confirmed" });
  });

  it.each([["POST", POST, f.create], ["PATCH", PATCH, f.update], ["DELETE", DELETE, f.remove]] as const)("maps %s domain conflicts/input errors and hides internal failures", async (method, handler, writer) => {
    const body = method === "POST" ? { ...task, title: "Follow up", sourceEventIds: ["source-a"] } : task;
    writer.mockRejectedValueOnce(new TaskActionConflict("Task changed; refresh before acting"));
    expect((await handler(request(method, body))).status).toBe(409);
    writer.mockRejectedValueOnce(new TaskActionInputError("Invalid task command/version"));
    expect((await handler(request(method, body))).status).toBe(400);
    writer.mockRejectedValueOnce(Error("SQL SELECT secret FROM internal_table"));
    const failure = await handler(request(method, body));
    expect(failure.status).toBe(500);
    expect(JSON.stringify(await failure.json())).not.toMatch(/SQL|secret|internal_table/);
  });
});
