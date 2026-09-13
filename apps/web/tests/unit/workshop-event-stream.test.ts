import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), access: vi.fn(), list: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn() }));
vi.mock("@/app/(auth)/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/work-runtime", () => ({ assertWorkAccess: mocks.access, listWorkEvents: mocks.list }));
vi.mock("@/lib/workshops/event-bus", () => ({ subscribeWorkshopEvents: mocks.subscribe }));
import { GET } from "@/app/api/workshops/[id]/events/stream/route";
const event = (seq: number) => ({id: `event-${seq}`, seq, type: "observation"});
const decoder = new TextDecoder();
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  mocks.auth.mockResolvedValue({user: {id: "owner"}}); mocks.access.mockResolvedValue({});
  mocks.subscribe.mockReturnValue(mocks.unsubscribe);
});
afterEach(() => { vi.useRealTimers(); });
describe("durable workshop event stream", () => {
  it("replays cursor gaps, ignores bus payload order and recovers a missed notification", async () => {
    mocks.list.mockResolvedValueOnce([event(7), event(9), event(9)]).mockResolvedValueOnce([event(10)]).mockResolvedValue([event(11)]);
    const request = new NextRequest("http://localhost/api/workshops/work/events/stream?after=2", {headers: {"last-event-id": "6"}});
    const response = await GET(request, {params: Promise.resolve({id: "work"})});
    const reader = response.body!.getReader();
    expect(decoder.decode((await reader.read()).value)).toContain("id: 7\n");
    expect(decoder.decode((await reader.read()).value)).toContain("id: 9\n");
    expect(mocks.list).toHaveBeenCalledWith(expect.objectContaining({afterSeq: 6}));
    const wakeup = mocks.subscribe.mock.calls[0][1];
    wakeup(event(999)); // Never forward an out-of-order bus payload directly.
    await vi.advanceTimersByTimeAsync(0);
    expect(decoder.decode((await reader.read()).value)).toContain("id: 10\n");
    await vi.advanceTimersByTimeAsync(1000); // No bus notification for event 11.
    expect(decoder.decode((await reader.read()).value)).toContain("id: 11\n");
    await reader.cancel();
    const calls = mocks.list.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.list).toHaveBeenCalledTimes(calls);
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("exposes read failures and retries without advancing the durable cursor", async () => {
    mocks.list.mockRejectedValueOnce(new Error("fixture DB unavailable")).mockResolvedValue([event(13)]);
    const response = await GET(new NextRequest("http://localhost/api/workshops/work/events/stream?after=12"), {params: Promise.resolve({id: "work"})});
    const reader = response.body!.getReader();
    expect(decoder.decode((await reader.read()).value)).toContain("fixture DB unavailable");
    await vi.advanceTimersByTimeAsync(5000);
    expect(decoder.decode((await reader.read()).value)).toContain("id: 13\n");
    expect(mocks.list.mock.calls[1][0].afterSeq).toBe(12);
    await reader.cancel();
  });
});
