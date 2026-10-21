import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), lease: vi.fn(), inspect: vi.fn(), rebase: vi.fn(), revoke: vi.fn() }));
vi.mock("@/app/(auth)/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/work-runtime/execution-context", () => ({ resolveExecutionLease: mocks.lease }));
vi.mock("@/lib/memory", () => ({ createOwnerMemoryClient: vi.fn() }));
vi.mock("@/lib/memory/plans/service", () => ({ inspectMemoryPlan: mocks.inspect, rebaseLegacyMemoryPlan: mocks.rebase, revokeMemoryPlan: mocks.revoke }));
import { GET } from "@/app/api/memory/plans/[planId]/route";
import { POST as rebase } from "@/app/api/memory/plans/[planId]/rebase/route";
import { POST as revoke } from "@/app/api/memory/plans/[planId]/revoke/route";
import { MemoryModuleError } from "@/lib/memory/kernel/errors";
const owner = "00000000-0000-4000-8000-000000000001", commandId = "00000000-0000-4000-8000-000000000002";
const parameters = { params: Promise.resolve({ planId: "synthetic-old-plan" }) };
const body = { commandId, expectedLegacyVersion: "legacyplan1:" + "a".repeat(64), inputPrompt: "Synthetic current instruction", sourceReceiptIds: [], confirmed: true };
function request(value: unknown) { return new Request("http://localhost/api/memory/plans/synthetic-old-plan/rebase", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) }); }
describe("owner memory plan HTTP review", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.auth.mockResolvedValue({ user: { id: owner } }); mocks.lease.mockReturnValue(undefined); mocks.inspect.mockResolvedValue({ kind: "legacy_unverified", historicalSources: "unknown" }); mocks.rebase.mockResolvedValue({ state: "ready", version: "mplan1:" + "b".repeat(64) }); mocks.revoke.mockResolvedValue({ state: "revoked" }); });
  it("reads only the session owner's plan and disables public caching", async () => {
    const response = await GET(new Request("http://localhost/api/memory/plans/synthetic-old-plan"), parameters);
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocks.inspect).toHaveBeenCalledWith(owner, "synthetic-old-plan"); expect(await response.json()).toMatchObject({ historicalSources: "unknown" });
  });
  it("rejects owner query overrides instead of widening inspection", async () => {
    expect((await GET(new Request("http://localhost/api/memory/plans/synthetic-old-plan?userId=another"), parameters)).status).toBe(400); expect(mocks.inspect).not.toHaveBeenCalled();
  });
  it.each([GET, rebase, revoke])("refuses unauthenticated access", async handler => {
    mocks.auth.mockResolvedValue(null); expect((await handler(request(body), parameters)).status).toBe(401);
    expect(mocks.inspect).not.toHaveBeenCalled(); expect(mocks.rebase).not.toHaveBeenCalled(); expect(mocks.revoke).not.toHaveBeenCalled();
  });
  it.each([GET, rebase, revoke])("refuses Work capabilities before authentication or source reads", async handler => {
    mocks.lease.mockReturnValue({ workshopId: commandId }); expect((await handler(request(body), parameters)).status).toBe(403); expect(mocks.auth).not.toHaveBeenCalled();
    expect(mocks.inspect).not.toHaveBeenCalled(); expect(mocks.rebase).not.toHaveBeenCalled(); expect(mocks.revoke).not.toHaveBeenCalled();
  });
  it("preserves the exact recovery command and fixed revision across retries", async () => {
    expect((await rebase(request(body), parameters)).status).toBe(200); expect((await rebase(request(body), parameters)).status).toBe(200);
    expect(mocks.rebase.mock.calls).toEqual([[owner, "synthetic-old-plan", body], [owner, "synthetic-old-plan", body]]);
  });
  it("passes revocation through the same owner boundary", async () => {
    const command = { commandId, expectedVersion: "mplan1:" + "a".repeat(64) };
    expect((await revoke(request(command), parameters)).status).toBe(200); expect(mocks.revoke).toHaveBeenCalledWith(owner, "synthetic-old-plan", command);
  });
  it("bounds JSON before the service is invoked", async () => {
    const oversized = new Request("http://localhost/api/memory/plans/p/rebase", { method: "POST", headers: { "Content-Length": "1048577" }, body: "{}" });
    expect((await rebase(oversized, parameters)).status).toBe(413); expect(mocks.rebase).not.toHaveBeenCalled();
  });
  it("rejects malformed JSON without guessing a successful command", async () => {
    expect((await rebase(new Request("http://localhost/api/memory/plans/p/rebase", { method: "POST", body: "{" }), parameters)).status).toBe(400); expect(mocks.rebase).not.toHaveBeenCalled();
  });
  it("retains domain conflict semantics and hides unknown SQL errors", async () => {
    mocks.rebase.mockRejectedValueOnce(new MemoryModuleError("memory_plan_revision_conflict", 409, "Plan changed"));
    expect((await rebase(request(body), parameters)).status).toBe(409);
    mocks.revoke.mockRejectedValueOnce(new Error("SECRET connection SQL private source")); const response = await revoke(request(body), parameters);
    expect(response.status).toBe(503); expect(await response.text()).not.toContain("SECRET");
  });
});
