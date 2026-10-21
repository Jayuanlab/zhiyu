import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const mocks = vi.hoisted(() => ({auth: vi.fn(), read: vi.fn(), revise: vi.fn()}));
vi.mock("@/app/(auth)/auth", () => ({auth: mocks.auth}));
vi.mock("@/lib/memory/revision/revision", () => ({
  getBrainMemoryForRevision: mocks.read, reviseBrainMemory: mocks.revise,
  BrainMemoryRevisionError: class extends Error {
    constructor(public code: string, public status: number, message: string, public currentVersion?: string) { super(message); }
  },
}));
import { BrainMemoryRevisionError } from "@/lib/memory/revision/revision";
import { GET, POST } from "@/app/api/brain/memories/[id]/revision/route";
const params = {params: Promise.resolve({id: "memory-id"})};
const postRequest = (body: unknown) => new NextRequest("http://localhost/api/memory/memories/memory-id/revision", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
beforeEach(() => {vi.clearAllMocks(); mocks.auth.mockResolvedValue({user: {id: "owner-id"}});});

describe("memory revision HTTP boundary", () => {
  it("requires an authenticated owner before reads or writes", async () => {
    mocks.auth.mockResolvedValue(null);
    expect((await GET({} as NextRequest, params)).status).toBe(401);
    expect((await POST({} as NextRequest, params)).status).toBe(401);
    expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.revise).not.toHaveBeenCalled();
  });
  it("gets the live version with the authenticated user", async () => {
    mocks.read.mockResolvedValue({memory: {id: "memory-id"}, expectedVersion: "version"});
    expect(await (await GET({} as NextRequest, params)).json()).toMatchObject({expectedVersion: "version"});
    expect(mocks.read).toHaveBeenCalledWith({userId: "owner-id", memoryId: "memory-id"});
  });
  it("forwards raw submitted fields while supplying the owner identity server-side", async () => {
    const body = {commandId: "command", expectedVersion: "version", operation: "correct", authority: "owner_statement", reason: "reason", content: "content"};
    mocks.revise.mockResolvedValue({commandId: "command", replayed: false});
    const response = await POST(postRequest(body), params);
    expect(response.status).toBe(200);
    expect(mocks.revise).toHaveBeenCalledWith({requester: {type: "chat", userId: "owner-id", id: "brain-revision-api"}, memoryId: "memory-id", request: body});
  });
  it("preserves a 409 version conflict and returns the current token", async () => {
    mocks.revise.mockRejectedValue(new BrainMemoryRevisionError("version_conflict", 409, "Changed", "current"));
    const response = await POST(postRequest({}), params);
    expect(response.status).toBe(409); expect(await response.json()).toEqual({error: "Changed", code: "version_conflict", currentVersion: "current"});
  });
});
