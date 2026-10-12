import { ProxyAgent } from "undici";

let cachedProxy: { url: string; dispatcher: ProxyAgent } | undefined;

function retireProxy(dispatcher: ProxyAgent) {
  // Drain in-flight requests without delaying the next request or leaking errors.
  try { void dispatcher.close().catch(() => {}); }
  catch { /* A transport teardown failure must not reveal proxy credentials. */ }
}

function proxyDispatcher(): ProxyAgent | undefined {
  const configured = process.env.TYPESAFE_PROXY_URL?.trim();
  if (!configured) {
    if (cachedProxy) {
      const previous = cachedProxy;
      cachedProxy = undefined;
      retireProxy(previous.dispatcher);
    }
    return undefined;
  }

  let url: URL;
  try { url = new URL(configured); }
  catch { throw new Error("typesafe_proxy_invalid_url"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("typesafe_proxy_unsupported_protocol");
  }
  if (cachedProxy?.url === url.href) return cachedProxy.dispatcher;

  let dispatcher: ProxyAgent;
  try { dispatcher = new ProxyAgent(url.href); }
  catch { throw new Error("typesafe_proxy_initialization_error"); }
  const previous = cachedProxy;
  cachedProxy = { url: url.href, dispatcher };
  if (previous) retireProxy(previous.dispatcher);
  return dispatcher;
}

/** Jev alone uses this explicit proxy; no global dispatcher or ambient proxy env. */
export const fetchTypesafe: typeof fetch = async (input, init) => {
  const dispatcher = proxyDispatcher();
  if (!dispatcher) return fetch(input, init);
  const options = { ...init, dispatcher };
  try { return await fetch(input, options); }
  catch (error) {
    // Never retry directly or include proxy URLs/credentials in caller diagnostics.
    const safeError = new Error("typesafe_proxy_transport_error");
    if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
      safeError.name = error.name;
    }
    throw safeError;
  }
};
