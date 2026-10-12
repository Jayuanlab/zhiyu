import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), read: vi.fn() }));
vi.mock("@/app/(auth)/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/ai/chat/native-workshop-run", () => ({ readOwnerWorkshopRun: mocks.read,
  NativeWorkshopRunError: class extends Error { constructor(readonly code: string, message: string, readonly status = 409) { super(message); } },
}));
import { GET } from "@/app/api/workshops/[id]/runs/[runId]/route";
import { NativeWorkshopRunError } from "@/lib/ai/chat/native-workshop-run";
const context = { params: Promise.resolve({ id: "workshop-a", runId: "exact-run-a" }) };
beforeEach(() => { vi.resetAllMocks(); mocks.auth.mockResolvedValue({ user: { id: "actual-owner" } }); });
describe("exact owned Workshop run observation endpoint", () => {
  it("reads the path's exact run under the server owner and exposes its actual failure status", async () => {
    mocks.read.mockResolvedValue({ ok: true, status: "run_observed", workshopId: "workshop-a", run: { id: "exact-run-a", status: "failed", error: "provider unavailable" }, presentation: null });
    const response = await GET(new Request("http://localhost/ignored?ownerId=forged"), context);
    expect(response.status).toBe(200);
    expect(mocks.read).toHaveBeenCalledWith({ ownerId: "actual-owner", workshopId: "workshop-a", runId: "exact-run-a" });
    expect(await response.json()).toMatchObject({ run: { id: "exact-run-a", status: "failed" } });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });
  it("refuses an unauthenticated read before loading any run data", async () => {
    mocks.auth.mockResolvedValue(null);
    expect((await GET(new Request("http://localhost"), context)).status).toBe(401);
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it("does not substitute a latest run when the requested owned run is absent", async () => {
    mocks.read.mockRejectedValue(new NativeWorkshopRunError("workshop_run_not_found", "没有找到这轮运行。", 404));
    const response = await GET(new Request("http://localhost"), context);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ ok: false, error: "workshop_run_not_found" });
  });
});
