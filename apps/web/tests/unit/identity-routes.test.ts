import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), place: vi.fn() }));
vi.mock("@/app/(auth)/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/quant/client", () => ({ placeQuantPaperOrder: mocks.place, fetchQuantPaperOrders: vi.fn() }));
vi.mock("@/lib/quant/cache", () => ({ invalidateQuantReadCache: vi.fn() }));
import { POST as order } from "@/app/(chat)/api/quant/paper/orders/route";
import { POST as permission } from "@/app/api/native/agent/permission/route";
import { permissionResponses } from "@/lib/ai/native-permission-state";
import { GET as guest } from "@/app/(auth)/api/auth/guest/route";
const request = (body: unknown) => new Request("http://localhost/api", { method: "POST", body: JSON.stringify(body) });
beforeEach(() => { vi.clearAllMocks(); permissionResponses.clear(); mocks.auth.mockResolvedValue({ user: { id: "alice" } }); mocks.place.mockResolvedValue({}); });
describe("trusted action identity", () => {
  it("does not create or sign in a guest in authenticated mode", () => {
    vi.stubEnv("AUTH_MODE", "authenticated");
    expect(guest(request({})).status).toBe(403);
    vi.unstubAllEnvs();
  });
  it("rejects anonymous orders before calling the executor", async () => {
    mocks.auth.mockResolvedValue(null);
    expect((await order(request({}))).status).toBe(401);
    expect(mocks.place).not.toHaveBeenCalled();
  });
  it("derives the audit actor from session rather than payload", async () => {
    expect((await order(request({ commandId:'test-command',actor: "admin", code: "000001", side: "buy", quantity: 100, limit_price: 10 }))).status).toBe(200);
    expect(mocks.place).toHaveBeenCalledWith(expect.objectContaining({commandId:'test-command', actor: "user:alice" }),{ownerId:'alice',actorId:'user:alice',role:'owner'});
  });
  it('does not manufacture a fresh order key when a caller omitted it',async()=>{
    expect((await order(request({code:'000001',side:'buy',quantity:100,limit_price:10}))).status).toBe(400);
    expect(mocks.place).not.toHaveBeenCalled();
  });
  it("rejects cross-owner approvals and unreviewed input changes, and consumes once", async () => {
    const resolve = vi.fn();
    permissionResponses.set("tool", { ownerId: "bob", resolve, reject: vi.fn() });
    expect((await permission(request({ toolUseID: "tool", behavior: "allow" }) as never)).status).toBe(404);
    expect(resolve).not.toHaveBeenCalled();
    mocks.auth.mockResolvedValue({ user: { id: "bob" } });
    expect((await permission(request({ toolUseID: "tool", behavior: "allow", updatedInput: { command: "changed" } }) as never)).status).toBe(400);
    expect((await permission(request({ toolUseID: "tool", behavior: "allow" }) as never)).status).toBe(200);
    expect((await permission(request({ toolUseID: "tool", behavior: "allow" }) as never)).status).toBe(404);
    expect(resolve).toHaveBeenCalledTimes(1);
  });
});
