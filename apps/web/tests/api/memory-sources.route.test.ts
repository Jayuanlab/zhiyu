import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), lease: vi.fn(), inspect: vi.fn(), read: vi.fn(), observations: vi.fn() }));
vi.mock("@/app/(auth)/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/work-runtime/execution-context", () => ({ resolveExecutionLease: mocks.lease }));
vi.mock("@/lib/memory/sources/inspection", () => ({ inspectMemorySources: mocks.inspect }));
vi.mock("@/lib/memory/sources/service", () => ({ readOwnerSource: mocks.read }));
vi.mock("@/lib/memory", () => ({ createOwnerMemoryClient: vi.fn(), createObservation: vi.fn(), listObservations: mocks.observations }));
import { GET } from "@/app/api/memory/sources/route";
import { POST } from "@/app/api/memory/sources/read/route";
import * as canonical from "@/app/api/memory/observations/route";
import * as historical from "@/app/api/brain/observations/route";
import { errorResponse } from "@/app/api/memory/owner-route-helpers";
const owner = "00000000-0000-4000-8000-000000000001", id = "00000000-0000-4000-8000-000000000002";
const request = (body: unknown) => new Request("http://localhost/api/memory/sources/read", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
describe("Memory canonical source HTTP boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.auth.mockResolvedValue({ user: { id: owner } }); mocks.lease.mockReturnValue(undefined);
    mocks.inspect.mockResolvedValue({ status: "unobserved", sources: [], receipts: [], complete: false });
    mocks.read.mockResolvedValue({ status: "read", receiptId: id, content: "Synthetic public window" });
  });
  it("returns bounded readonly coverage without reading a body", async () => {
    const response = await GET(new Request("http://localhost/api/memory/sources?limit=3"));
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocks.inspect).toHaveBeenCalledWith(owner, 3); expect(mocks.read).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({ status: "unobserved", complete: false });
  });
  it.each(["limit=2&limit=3", "workId=" + id, "userId=" + id, "source=message"])("rejects authority or ambiguous inspection input %s", async query => {
    expect((await GET(new Request("http://localhost/api/memory/sources?" + query))).status).toBe(400); expect(mocks.inspect).not.toHaveBeenCalled();
  });
  it("normalizes a registered source identity and preserves exact window constraints", async () => {
    const response = await POST(request({ source: "message", id: id.toUpperCase(), offset: 4, expectedHash: "a".repeat(64), expectedRevision: "msrc1:" + "b".repeat(64) }));
    expect(response.status).toBe(200); expect(mocks.read).toHaveBeenCalledWith({ userId: owner, source: "message", id, offset: 4, expectedHash: "a".repeat(64), expectedRevision: "msrc1:" + "b".repeat(64) });
  });
  it.each([{ source: "arbitrary_table", id }, { source: "message", id, userId: id }, { source: "message", id, requester: { type: "system" } },
    { source: "message", id, offset: -1 }, { source: "message", id, expectedHash: "fake" }])("rejects unregistered source and spoofed capabilities", async body => {
    expect((await POST(request(body))).status).toBe(400); expect(mocks.read).not.toHaveBeenCalled();
  });
  it("refuses Work owner escalation before authentication or data access", async () => {
    mocks.lease.mockReturnValue({ workshopId: id });
    expect((await POST(request({ source: "message", id }))).status).toBe(403); expect(mocks.auth).not.toHaveBeenCalled(); expect(mocks.read).not.toHaveBeenCalled();
  });
  it("requires authentication", async () => {
    mocks.auth.mockResolvedValue(null); expect((await POST(request({ source: "message", id }))).status).toBe(401); expect(mocks.read).not.toHaveBeenCalled();
  });
  it("bounds transport before accessing any source", async () => {
    const response = await POST(new Request("http://localhost/api/memory/sources/read", { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": "1048577" }, body: "{}" }));
    expect(response.status).toBe(413); expect(mocks.read).not.toHaveBeenCalled();
  });
  it("never returns SQL or prepared source body on an unknown failure", async () => {
    mocks.read.mockRejectedValue(new Error("SECRET SQL connection contents")); const response = await POST(request({ source: "message", id }));
    expect(response.status).toBe(503); expect(await response.text()).not.toContain("SECRET");
    expect(await errorResponse(new Error("SECRET driver"), "Unavailable").text()).not.toContain("SECRET");
  });
  it("retains old HTTP handlers as exact named compatibility exports", () => {
    expect(historical.GET).toBe(canonical.GET); expect(historical.POST).toBe(canonical.POST);
  });
});
