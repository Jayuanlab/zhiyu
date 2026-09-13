import { beforeEach, describe, expect, it, vi } from "vitest";

const runLoopHarnessMock = vi.hoisted(() => vi.fn());
const getLoopDashboardDetailMock = vi.hoisted(() => vi.fn());

vi.mock("@/app/(auth)/auth", () => ({
  auth: vi.fn(async () => ({ user: { id: "user-1" } })),
}));

vi.mock("@/lib/loops/dashboard", () => ({
  getLoopDashboardDetail: getLoopDashboardDetailMock,
}));

vi.mock("@/lib/loops/harness", () => ({
  runLoopHarness: runLoopHarnessMock,
}));

import { POST } from "@/app/(chat)/api/loops/[id]/execute/route";

function request(body: Record<string, unknown>) {
  return new Request("http://localhost/api/loops/loop-1/execute", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({commandId:'stable-test-command',expectedVersion:3,...body}),
  });
}

describe("loop execute route", () => {
  it('accepts the shared Idempotency-Key header for command-aware callers',async()=>{
    runLoopHarnessMock.mockResolvedValue({result:{status:'success'},harness:{name:'loop-run-harness',mode:'dry_run'}});
    const response=await POST(new Request('http://localhost/api/loops/loop-1/execute',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':'header-command'},body:JSON.stringify({dryRun:true,expectedVersion:2})}),{params:Promise.resolve({id:'loop-1'})});
    expect(response.status).toBe(200);expect((await response.json()).commandId).toBe('header-command');
    expect(runLoopHarnessMock).toHaveBeenCalledWith(expect.objectContaining({commandId:'header-command',expectedVersion:2}));
  });
  it('rejects missing identity, invalid mode and a mismatched actor before execution',async()=>{
    const context={params:Promise.resolve({id:'loop-1'})};
    expect((await POST(request({commandId:''}),context)).status).toBe(400);
    expect((await POST(request({dryRun:'false'}),context)).status).toBe(400);
    const changed=request({});changed.headers.set('X-Work-Actor','foreign');expect((await POST(changed,context)).status).toBe(409);
    expect(runLoopHarnessMock).not.toHaveBeenCalled();
  });
  beforeEach(() => {
    runLoopHarnessMock.mockReset();
    getLoopDashboardDetailMock.mockReset();
    getLoopDashboardDetailMock.mockResolvedValue({ id: "loop-1" });
  });

  it("routes dry-run execution through the loop harness", async () => {
    runLoopHarnessMock.mockResolvedValue({
      result: { status: "success" },
      harness: { name: "loop-run-harness", mode: "dry_run" },
    });

    const response = await POST(request({ dryRun: true }), {
      params: Promise.resolve({ id: "loop-1" }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.result).toEqual({ status: "success" });
    expect(body.harness).toEqual({
      name: "loop-run-harness",
      mode: "dry_run",
    });
    expect(runLoopHarnessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        loopId: "loop-1",
        mode: "dry_run",
        triggeredBy: "manual",
        commandId:'stable-test-command',
        expectedVersion:3,
      }),
    );
  });

  it("routes real execution through native-agent harness mode", async () => {
    runLoopHarnessMock.mockResolvedValue({
      result: { status: "success" },
      harness: { name: "loop-run-harness", mode: "native_agent" },
    });

    const response = await POST(request({ dryRun: false }), {
      params: Promise.resolve({ id: "loop-1" }),
    });

    expect(response.status).toBe(200);
    expect(runLoopHarnessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        loopId: "loop-1",
        mode: "native_agent",
        triggeredBy: "manual",
      }),
    );
  });
});
