import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createProxy: vi.fn(),
  setGlobalDispatcher: vi.fn(),
}));

vi.mock("undici", () => ({
  ProxyAgent: class {
    constructor(uri: string) { return mocks.createProxy(uri); }
  },
  setGlobalDispatcher: mocks.setGlobalDispatcher,
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.createProxy.mockReset();
  vi.stubEnv("TYPESAFE_PROXY_URL", "");
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("Jev per-request proxy transport", () => {
  it("attaches an explicit proxy dispatcher only to this request", async () => {
    const dispatcher = { dispatch: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
    mocks.createProxy.mockReturnValue(dispatcher);
    vi.stubEnv("TYPESAFE_PROXY_URL", "http://127.0.0.1:7897");
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchTypesafe } = await import("@/lib/brain/jev-fetch");
    const signal = new AbortController().signal;
    const init = { method: "POST", signal, body: "original-payload", headers: { Authorization: "Bearer test-key" } };

    await fetchTypesafe("https://api.typesafe.ai/v1/systemone", init);

    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("https://api.typesafe.ai/v1/systemone", { ...init, dispatcher });
    expect(mocks.createProxy).toHaveBeenCalledExactlyOnceWith("http://127.0.0.1:7897/");
    expect(mocks.setGlobalDispatcher).not.toHaveBeenCalled();
    expect(init).not.toHaveProperty("dispatcher");
  });

  it("keeps unconfigured requests direct and ignores unrelated proxy environment", async () => {
    vi.stubEnv("HTTPS_PROXY", "http://ambient:private@127.0.0.1:9000");
    vi.stubEnv("HTTP_PROXY", "http://127.0.0.1:9001");
    vi.stubEnv("ALL_PROXY", "socks5://127.0.0.1:9002");
    const response = new Response("ok");
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetchMock);
    const { fetchTypesafe } = await import("@/lib/brain/jev-fetch");
    const request = new Request("https://api.typesafe.ai/v1/systemone", { method: "POST", body: "payload" });
    const init = { signal: new AbortController().signal };

    expect(await fetchTypesafe(request, init)).toBe(response);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(request, init);
    expect(mocks.createProxy).not.toHaveBeenCalled();
    expect(mocks.setGlobalDispatcher).not.toHaveBeenCalled();
  });

  it("supports an HTTPS proxy and preserves URL inputs", async () => {
    const dispatcher = { dispatch: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
    mocks.createProxy.mockReturnValue(dispatcher);
    vi.stubEnv("TYPESAFE_PROXY_URL", "  https://127.0.0.1:7897  ");
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchTypesafe } = await import("@/lib/brain/jev-fetch");
    const input = new URL("https://api.typesafe.ai/v1/systemone");
    await fetchTypesafe(input);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(input, { dispatcher });
    expect(mocks.createProxy).toHaveBeenCalledExactlyOnceWith("https://127.0.0.1:7897/");
  });

  it.each(["socks5://user:private@127.0.0.1:7897", "file:///proxy", "invalid-private-proxy-url"])(
    "rejects invalid or unsupported proxy configuration before a request: %s", async value => {
      vi.stubEnv("TYPESAFE_PROXY_URL", value);
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const { fetchTypesafe } = await import("@/lib/brain/jev-fetch");
      const error = await fetchTypesafe("https://api.typesafe.ai/v1/systemone").catch(error => error);
      expect(error.message).toMatch(/^typesafe_proxy_(invalid_url|unsupported_protocol)$/);
      expect(error.message).not.toContain("private");
      expect(error.message).not.toContain(value);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(mocks.createProxy).not.toHaveBeenCalled();
    },
  );

  it("caches by normalized URL and closes the previous dispatcher on a change", async () => {
    const previous = { dispatch: vi.fn(), close: vi.fn().mockRejectedValue(new Error("private-close-error")) };
    const replacement = { dispatch: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
    mocks.createProxy.mockReturnValueOnce(previous).mockReturnValueOnce(replacement);
    vi.stubEnv("TYPESAFE_PROXY_URL", "http://127.0.0.1:7897");
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchTypesafe } = await import("@/lib/brain/jev-fetch");
    await fetchTypesafe("https://api.typesafe.ai/v1/systemone");
    vi.stubEnv("TYPESAFE_PROXY_URL", " http://127.0.0.1:7897/ ");
    await fetchTypesafe("https://api.typesafe.ai/v1/systemone");
    expect(mocks.createProxy).toHaveBeenCalledTimes(1);
    vi.stubEnv("TYPESAFE_PROXY_URL", "http://127.0.0.1:7898");
    await fetchTypesafe("https://api.typesafe.ai/v1/systemone");
    await Promise.resolve();
    expect(mocks.createProxy).toHaveBeenCalledTimes(2);
    expect(previous.close).toHaveBeenCalledTimes(1);
    expect(replacement.close).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.map(call => call[1].dispatcher)).toEqual([previous, previous, replacement]);
    expect(mocks.setGlobalDispatcher).not.toHaveBeenCalled();
  });

  it("closes the proxy and returns to direct requests only when configuration is explicitly cleared", async () => {
    const dispatcher = { dispatch: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
    mocks.createProxy.mockReturnValue(dispatcher);
    vi.stubEnv("TYPESAFE_PROXY_URL", "http://127.0.0.1:7897");
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchTypesafe } = await import("@/lib/brain/jev-fetch");
    await fetchTypesafe("https://api.typesafe.ai/v1/systemone");
    vi.stubEnv("TYPESAFE_PROXY_URL", "  ");
    await fetchTypesafe("https://api.typesafe.ai/v1/systemone");
    expect(dispatcher.close).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[1]).toEqual(["https://api.typesafe.ai/v1/systemone", undefined]);
  });

  it("does not retry directly after a proxy failure and hides its credentials", async () => {
    const dispatcher = { dispatch: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
    mocks.createProxy.mockReturnValue(dispatcher);
    vi.stubEnv("TYPESAFE_PROXY_URL", "http://user:private@127.0.0.1:7897");
    const fetchMock = vi.fn().mockRejectedValue(new Error("connection failure http://user:private@127.0.0.1:7897"));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchTypesafe } = await import("@/lib/brain/jev-fetch");
    const error = await fetchTypesafe("https://api.typesafe.ai/v1/systemone").catch(error => error);
    expect(error.message).toBe("typesafe_proxy_transport_error");
    expect(String(error)).not.toContain("private");
    expect(error).not.toHaveProperty("cause");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].dispatcher).toBe(dispatcher);
  });

  it("passes cancellation through without replacing the signal or making another request", async () => {
    const dispatcher = { dispatch: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
    mocks.createProxy.mockReturnValue(dispatcher);
    vi.stubEnv("TYPESAFE_PROXY_URL", "http://127.0.0.1:7897");
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn().mockRejectedValue(new DOMException("cancelled", "AbortError"));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchTypesafe } = await import("@/lib/brain/jev-fetch");
    await expect(fetchTypesafe("https://api.typesafe.ai/v1/systemone", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].signal).toBe(controller.signal);
  });

  it("returns HTTP failures unchanged for the caller to record their actual status", async () => {
    const dispatcher = { dispatch: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
    mocks.createProxy.mockReturnValue(dispatcher);
    vi.stubEnv("TYPESAFE_PROXY_URL", "http://127.0.0.1:7897");
    const response = new Response("synthetic provider denial", { status: 451 });
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetchMock);
    const { fetchTypesafe } = await import("@/lib/brain/jev-fetch");
    expect(await fetchTypesafe("https://api.typesafe.ai/v1/systemone")).toBe(response);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sanitizes dispatcher construction errors without falling back directly", async () => {
    mocks.createProxy.mockImplementation(() => { throw new Error("private-proxy-credentials"); });
    vi.stubEnv("TYPESAFE_PROXY_URL", "http://user:private@127.0.0.1:7897");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { fetchTypesafe } = await import("@/lib/brain/jev-fetch");
    await expect(fetchTypesafe("https://api.typesafe.ai/v1/systemone")).rejects.toThrow("typesafe_proxy_initialization_error");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
