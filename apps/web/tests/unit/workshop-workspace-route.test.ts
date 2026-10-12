import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  auth: vi.fn(), getWorkshop: vi.fn(), appendWorkshopEvent: vi.fn(), listLoopsForWorkshop: vi.fn(), inspectWorkspace: vi.fn(), prepareWorkspace: vi.fn(),
}));
vi.mock("@/app/(auth)/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/workshops/service", () => ({ getWorkshop: mocks.getWorkshop, appendWorkshopEvent: mocks.appendWorkshopEvent }));
vi.mock("@/lib/loops/service", () => ({ listLoopsForWorkshop: mocks.listLoopsForWorkshop }));
vi.mock("@/lib/workshops/workspace", () => ({ inspectWorkspace: mocks.inspectWorkspace, prepareWorkspace: mocks.prepareWorkspace }));
import { GET, POST } from "@/app/api/workshops/[id]/workspace/route";
import { NextRequest } from "next/server";
const context = { params: Promise.resolve({ id: "work" }) };
function request(method = "GET", actor?: string) {
  return new NextRequest("http://localhost/api/workshops/work/workspace", { method, headers: actor ? { "X-Work-Actor": actor } : {} });
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ user: { id: "owner" } });
  mocks.getWorkshop.mockResolvedValue({ id: "work" });
  mocks.listLoopsForWorkshop.mockResolvedValue([{ id: "loop", name: "Daily" }]);
  mocks.inspectWorkspace.mockImplementation(async scope => ({ ...scope, status: "ready" }));
});
describe("workspace owner API", () => {
  it("does not reveal or provision storage to unauthenticated or non-owning callers", async () => {
    mocks.auth.mockResolvedValue(null);
    expect((await GET(request(), context)).status).toBe(401);
    expect(mocks.getWorkshop).not.toHaveBeenCalled();
    mocks.auth.mockResolvedValue({ user: { id: "owner" } });
    mocks.getWorkshop.mockResolvedValue(null);
    expect((await POST(request("POST"), context)).status).toBe(404);
    expect(mocks.inspectWorkspace).not.toHaveBeenCalled();
    expect(mocks.prepareWorkspace).not.toHaveBeenCalled();
  });
  it("GET is read-only and only inspects owner-scoped Loops from the database", async () => {
    const result = await GET(request(), context);
    expect(result.status).toBe(200);
    expect(mocks.listLoopsForWorkshop).toHaveBeenCalledWith({ userId: "owner", workshopId: "work", limit: 200 });
    expect(mocks.inspectWorkspace).toHaveBeenCalledWith({ userId: "owner", workshopId: "work", loopId: "loop" });
    expect(mocks.prepareWorkspace).not.toHaveBeenCalled();
    expect(mocks.appendWorkshopEvent).not.toHaveBeenCalled();
  });
  it("rejects an actor change and repeats preparation without duplicate completion events", async () => {
    expect((await POST(request("POST", "someone-else"), context)).status).toBe(409);
    expect(mocks.prepareWorkspace).not.toHaveBeenCalled();
    expect((await POST(request("POST", "owner"), context)).status).toBe(200);
    expect(mocks.prepareWorkspace).not.toHaveBeenCalled();
    expect(mocks.appendWorkshopEvent).not.toHaveBeenCalled();
  });
  it("audits preparation and surfaces storage failure instead of claiming success", async () => {
    mocks.inspectWorkspace.mockImplementation(async scope => ({ ...scope, status: "not_created" }));
    mocks.prepareWorkspace.mockRejectedValue(new Error("disk unavailable"));
    const result = await POST(request("POST"), context);
    expect(result.status).toBe(500);
    expect(await result.json()).toEqual({ error: "disk unavailable" });
    expect(mocks.appendWorkshopEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "workspace_preparation_requested" }));
    expect(mocks.appendWorkshopEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "workspace_preparation_failed", body: "disk unavailable" }));
    expect(mocks.appendWorkshopEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: "workspace_prepared" }));
  });
  it("prepares workshop and Loop spaces and records owner provenance", async () => {
    mocks.inspectWorkspace.mockImplementation(async scope => ({ ...scope, status: "not_created" }));
    expect((await POST(request("POST"), context)).status).toBe(200);
    expect(mocks.prepareWorkspace).toHaveBeenCalledWith({ userId: "owner", workshopId: "work" });
    expect(mocks.prepareWorkspace).toHaveBeenCalledWith({ userId: "owner", workshopId: "work", loopId: "loop" });
    expect(mocks.appendWorkshopEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "workspace_prepared", metadata: expect.objectContaining({ actorId: "owner" }) }));
  });
});
