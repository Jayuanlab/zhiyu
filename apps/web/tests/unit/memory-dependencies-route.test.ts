import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), read: vi.fn(), bind: vi.fn(), list: vi.fn() }));
vi.mock("@/app/(auth)/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/memory/revision/dependencies", async () => ({
  ...await import("@/lib/memory/revision/dependencies-common"), getMemoryDependencies: mocks.read,
  bindMemoryDependencies: mocks.bind, listMemoryDependencyImpacts: mocks.list,
}));
import { MemoryDependencyError } from "@/lib/memory/revision/dependencies-common";
import { GET, POST } from "@/app/api/brain/memory-dependencies/[entityKind]/[entityId]/route";
import { GET as LIST } from "@/app/api/brain/memory-dependencies/route";
const id = "00000000-0000-4000-8000-000000000002";
const context = { params: Promise.resolve({ entityKind: "interaction_task", entityId: id }) };
const requester = { type: "chat", userId: "authenticated-owner", id: "brain-dependency-api" };
beforeEach(() => { vi.clearAllMocks(); mocks.auth.mockResolvedValue({ user: { id: requester.userId } }); });
describe("dependency HTTP compatibility with Memory implementation", () => {
  it("requires authentication before exact reads, binds and impact pages", async () => {
    mocks.auth.mockResolvedValue(null);
    const request = new NextRequest("http://localhost/api/brain/memory-dependencies");
    expect((await GET(request, context)).status).toBe(401);
    expect((await POST(request, context)).status).toBe(401);
    expect((await LIST(request)).status).toBe(401);
    expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.bind).not.toHaveBeenCalled(); expect(mocks.list).not.toHaveBeenCalled();
  });
  it("passes authenticated ownership and the exact typed target to the migrated read", async () => {
    mocks.read.mockResolvedValue({ coverage: "unknown", assessment: "unknown", sources: [] });
    const response = await GET(new NextRequest("http://localhost/"), context);
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ coverage: "unknown" });
    expect(mocks.read).toHaveBeenCalledWith({ requester, entityKind: "interaction_task", entityId: id });
  });
  it("does not derive server requester ownership from submitted fields", async () => {
    const body = { commandId: "synthetic-command", userId: "forged-owner", evidenceConfirmed: true };
    mocks.bind.mockResolvedValue({ replayed: false, receipt: { commandId: body.commandId } });
    const response = await POST(new NextRequest("http://localhost/", { method: "POST", body: JSON.stringify(body) }), context);
    expect(response.status).toBe(200);
    expect(mocks.bind).toHaveBeenCalledWith({ requester, entityKind: "interaction_task", entityId: id, request: body });
  });
  it("preserves migrated denial and version-conflict errors at the legacy route", async () => {
    for (const [code, status] of [["dependency_source_denied", 403], ["dependency_version_conflict", 409]] as const) {
      mocks.bind.mockRejectedValueOnce(new MemoryDependencyError(code, status, code));
      const response = await POST(new NextRequest("http://localhost/", { method: "POST", body: "{}" }), context);
      expect(response.status).toBe(status); expect(await response.json()).toEqual({ error: code, code });
    }
  });
  it("forwards bounded pagination and filters without changing the authenticated owner", async () => {
    mocks.list.mockResolvedValue({ items: [], hasMore: true, nextCursor: "next", coverage: "recorded" });
    const response = await LIST(new NextRequest(`http://localhost/api/brain/memory-dependencies?sourceMemoryId=${id}&workId=${id}&limit=5&cursor=opaque`));
    expect(response.status).toBe(200);
    expect(mocks.list).toHaveBeenCalledWith({ requester, sourceMemoryId: id, workId: id, limit: 5, cursor: "opaque" });
    expect(await response.json()).toMatchObject({ hasMore: true, coverage: "recorded" });
  });
});
