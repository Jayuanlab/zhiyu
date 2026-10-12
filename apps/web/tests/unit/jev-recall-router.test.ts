import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { transport } = vi.hoisted(() => ({ transport: vi.fn() }));
vi.mock("@/lib/brain/jev-fetch", () => ({ fetchTypesafe: transport }));
import { routeRecallWithJev } from "@/lib/brain/jev-recall-router";

const scored = { answers: Object.fromEntries(["architecture", "records", "knowledge", "brain"].map(source =>
  [source, { type: "noul", noul: source === "architecture" ? 0.95 : 0.01 }])) };

beforeEach(() => {
  transport.mockReset().mockImplementation(async () => Response.json(scored));
  vi.stubEnv("PLATFORM_REASONING_MODE", "optimized");
  vi.stubEnv("TYPESAFE_API_KEY", "test-key");
  vi.stubEnv("BRAIN_JEV_ROUTING", "off");
  vi.stubEnv("PLATFORM_RECALL_PREFETCH", "rules");
  vi.stubEnv("PLATFORM_CAPABILITY_ROUTING", "rules");
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("Jev router opt-in and bounded transport", () => {
  it("ignores every environment opt-in in the agent baseline while preserving an explicit low-level request", async () => {
    vi.stubEnv("PLATFORM_REASONING_MODE", "agent");
    vi.stubEnv("BRAIN_RECALL_PLANNER", "rules");
    vi.stubEnv("BRAIN_JEV_ROUTING", "replace");
    vi.stubEnv("BRAIN_JEV_MODE", "active");
    vi.stubEnv("BRAIN_JEV_TARGETED_RETRY", "true");
    vi.stubEnv("PLATFORM_RECALL_PREFETCH", "jev");
    vi.stubEnv("PLATFORM_CAPABILITY_ROUTING", "jev");
    expect((await routeRecallWithJev("architecture")).status).toBe("disabled");
    expect(transport).not.toHaveBeenCalled();
    expect((await routeRecallWithJev("architecture", undefined, { enabled: true })).status).toBe("ok");
    expect(transport).toHaveBeenCalledOnce();
  });
  it("keeps default direct calls disabled and legacy direct opt-in compatible", async () => {
    expect((await routeRecallWithJev("architecture")).status).toBe("disabled");
    expect(transport).not.toHaveBeenCalled();
    vi.stubEnv("BRAIN_JEV_ROUTING", "replace");
    expect(await routeRecallWithJev("architecture")).toMatchObject({ status: "ok", route: "architecture", schemaVersion: "recall-sources.v2" });
    expect(JSON.parse(transport.mock.calls[0][1].body).state).toEqual({ question: "architecture" });
  });

  it.each(["PLATFORM_RECALL_PREFETCH", "PLATFORM_CAPABILITY_ROUTING"])("allows independent explicit opt-in through %s", async key => {
    vi.stubEnv(key, "jev");
    expect((await routeRecallWithJev("architecture")).status).toBe("ok");
    expect(transport).toHaveBeenCalledOnce();
  });

  it("honors explicit disable above all environment opt-ins", async () => {
    vi.stubEnv("BRAIN_JEV_ROUTING", "replace");
    vi.stubEnv("PLATFORM_RECALL_PREFETCH", "jev");
    vi.stubEnv("PLATFORM_CAPABILITY_ROUTING", "jev");
    expect((await routeRecallWithJev("architecture", undefined, { enabled: false })).status).toBe("disabled");
    expect(transport).not.toHaveBeenCalled();
  });

  it("passes only a redacted bounded context summary and audits its version/hash", async () => {
    const first = await routeRecallWithJev("What about it?", undefined, { enabled: true, context: "Entity: work-1; password=private-value" });
    const request = JSON.parse(transport.mock.calls[0][1].body);
    expect(request.state).toEqual({ question: "What about it?", context: "Entity: work-1; password=[REDACTED]" });
    expect(first).toMatchObject({ status: "ok", schemaVersion: "recall-sources.v3" });
    const second = await routeRecallWithJev("What about it?", undefined, { enabled: true, context: "Entity: work-2" });
    expect(first.inputHash).not.toBe(second.inputHash);
    expect(JSON.stringify(first)).not.toContain("private-value");
  });

  it("rejects oversized context before transport rather than silently truncating", async () => {
    expect(await routeRecallWithJev("q", undefined, { enabled: true, context: "x".repeat(2001) })).toMatchObject({ status: "degraded", detail: "context_too_long" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("releases an HTTP error body while preserving its status even when cleanup rejects", async () => {
    const cancel = vi.fn(async () => { throw Error("private cleanup detail"); });
    const response = new Response(new ReadableStream({ cancel }), { status: 451 });
    transport.mockResolvedValueOnce(response);
    const result = await routeRecallWithJev("q", undefined, { enabled: true });
    expect(result).toMatchObject({ status: "degraded", detail: "http_451" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it("bounds response bytes and cancels an oversized stream", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(100_001)); }, cancel }));
    transport.mockResolvedValueOnce(response);
    expect(await routeRecallWithJev("q", undefined, { enabled: true })).toMatchObject({ status: "degraded", detail: "response_too_large" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
  });

  it("accepts valid JSON at the byte boundary and rejects malformed JSON safely", async () => {
    const json = JSON.stringify(scored);
    transport.mockResolvedValueOnce(new Response(json + " ".repeat(100_000 - Buffer.byteLength(json))));
    expect((await routeRecallWithJev("q", undefined, { enabled: true })).status).toBe("ok");
    transport.mockResolvedValueOnce(new Response("private invalid JSON"));
    const result = await routeRecallWithJev("q", undefined, { enabled: true });
    expect(result.detail).toBe("invalid_response");
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it("bounds body parsing and cancels a stream that never finishes", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    transport.mockResolvedValueOnce(new Response(new ReadableStream({ cancel })));
    const pending = routeRecallWithJev("q", undefined, { enabled: true });
    await vi.advanceTimersByTimeAsync(2000);
    expect(await pending).toMatchObject({ status: "degraded", detail: "timeout", elapsedMs: 2000 });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("returns promptly on user cancellation even when transport ignores abort", async () => {
    transport.mockImplementationOnce(() => new Promise<Response>(() => {}));
    const controller = new AbortController();
    const pending = routeRecallWithJev("q", controller.signal, { enabled: true });
    controller.abort();
    expect(await pending).toMatchObject({ status: "degraded", detail: "aborted" });
    expect(transport.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it.each(["typesafe_proxy_invalid_url", "typesafe_proxy_unsupported_protocol", "typesafe_proxy_initialization_error", "typesafe_proxy_transport_error"])("preserves safe transport diagnostic %s", async detail => {
    transport.mockRejectedValueOnce(Error(detail));
    expect((await routeRecallWithJev("q", undefined, { enabled: true })).detail).toBe(detail);
  });

  it("does not expose arbitrary transport messages", async () => {
    transport.mockRejectedValueOnce(Error("http://user:private@proxy.invalid connection failed"));
    const result = await routeRecallWithJev("q", undefined, { enabled: true });
    expect(result.detail).toBe("transport_error");
    expect(JSON.stringify(result)).not.toContain("private");
  });
});
