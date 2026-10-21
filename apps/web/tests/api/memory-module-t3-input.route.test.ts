import { beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ authenticated: true, lease: false,
  storage: vi.fn(() => { throw new Error("Input validation unexpectedly reached storage"); }),
}));
vi.mock("@/app/(auth)/auth", () => ({ auth: async () => f.authenticated
  ? { user: { id: "00000000-0000-4000-a000-000000000001" } } : null }));
vi.mock("@/lib/work-runtime/execution-context", () => ({ resolveExecutionLease: () => f.lease
  ? { userId: "00000000-0000-4000-a000-000000000001" } : undefined }));
vi.mock("@/lib/db/client", () => ({ db: { select: f.storage, insert: f.storage, transaction: f.storage }, withDatabaseTransaction: f.storage }));

// The actual HTTP route, owner capability, command parser and domain parsers run.
// Only persistence is replaced, and every malformed command must stop before it.
import { POST } from "@/app/api/memory/commands/route";
const memoryId = "00000000-0000-4000-a000-000000000002";
const version = `bmrv1:${"a".repeat(64)}`;
const candidate = { kind: "candidate.submit", commandId: "owner-command", subject: "Source claim", content: "Pending verification", memoryType: "fact" };
const review = { kind: "memory.review", commandId: "owner-review", memoryId, expectedVersion: version,
  decision: "confirmed", reason: "Checked the source", evidenceConfirmed: true };
const submit = (body: unknown) => POST(new Request("http://localhost/api/memory/commands", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
}));
beforeEach(() => { vi.clearAllMocks(); f.authenticated = true; f.lease = false; });

describe("Memory T3 public command input boundary", () => {
  it("requires an authenticated owner and refuses an inherited Work execution capability", async () => {
    f.authenticated = false;
    expect((await submit(candidate)).status).toBe(401);
    f.authenticated = true; f.lease = true;
    const response = await submit(candidate);
    expect(response.status).toBe(403); expect(await response.json()).toMatchObject({ code: "memory_owner_context_required" });
    expect(f.storage).not.toHaveBeenCalled();
  });

  it.each([
    { ...candidate, commandId: undefined }, { ...candidate, subject: undefined }, { ...candidate, content: undefined },
    { ...candidate, memoryType: undefined }, { ...candidate, userId: "foreign-owner" },
    { ...candidate, scope: { type: "work", workId: "other-work" } }, { ...candidate, status: "active" },
    { ...candidate, metadata: { authority: "owner" } },
  ])("rejects missing or injected candidate fields before storage: %j", async body => {
    const response = await submit(body);
    expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ code: "invalid_memory_request" });
    expect(f.storage).not.toHaveBeenCalled();
  });

  it.each([
    { ...review, expectedVersion: undefined }, { ...review, expectedVersion: "latest" }, { ...review, memoryId: "invalid" },
    { ...review, evidenceConfirmed: false }, { ...review, decision: ["confirmed"] },
    { ...review, ownerId: "foreign-owner" }, { ...review, metadata: { evidenceConfirmed: true } },
  ])("rejects incomplete review authority or versions before storage: %j", async body => {
    const response = await submit(body);
    expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ code: "invalid_memory_request" });
    expect(f.storage).not.toHaveBeenCalled();
  });

  it("uses the real proposal and revision parsers to reject changed identity fields", async () => {
    for (const body of [
      { kind: "memory.propose", commandId: "proposal", targetMemoryId: memoryId, expectedVersion: version,
        content: "Replacement", reason: "New source", ownerType: "system" },
      { kind: "memory.revise", commandId: "revision", memoryId, expectedVersion: version,
        operation: "correct", authority: "owner_statement", content: "Replacement", reason: "Owner correction", status: "active" },
    ]) expect((await submit(body)).status).toBe(400);
    expect(f.storage).not.toHaveBeenCalled();
  });
});
