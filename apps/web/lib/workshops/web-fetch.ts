import { EnvHttpProxyAgent } from "undici";

let dispatcher: EnvHttpProxyAgent | undefined;

export function publicNewsFeedFallback(url: URL, status: number): string | null {
  return status === 403 && url.hostname === "openai.com" && /^\/(news|blog)\/?$/.test(url.pathname)
    ? "https://openai.com/news/rss.xml" : null;
}

/** Only public-web tools use this transport; database/local services are unaffected. */
export async function fetchPublicWeb(url: string | URL, init: RequestInit = {}) {
  dispatcher ??= new EnvHttpProxyAgent({
    httpProxy: process.env.http_proxy || process.env.HTTP_PROXY || process.env.ALL_PROXY,
    httpsProxy: process.env.https_proxy || process.env.HTTPS_PROXY || process.env.ALL_PROXY,
  });
  const timeout = AbortSignal.timeout(15_000);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  const options = { ...init, signal, dispatcher };
  try {
    return await fetch(url, options);
  } catch (error) {
    throw new Error(describeWebFailure(error), { cause: error });
  }
}

export function describeWebFailure(error: unknown): string {
  const value = error as { message?: string; name?: string; cause?: { code?: string }; code?: string };
  const code = value?.cause?.code || value?.code;
  // Do not expose proxy credentials, request headers or raw connection URLs.
  if (code === "UND_ERR_CONNECT_TIMEOUT" || value?.name === "TimeoutError") return "Connection timed out (network/proxy): UND_ERR_CONNECT_TIMEOUT";
  if (code === "ECONNREFUSED") return "Connection refused (check network/proxy): ECONNREFUSED";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return `DNS lookup failed: ${code}`;
  if (code) return `Web connection failed: ${/^[A-Z0-9_]+$/.test(code) ? code : "UNKNOWN"}`;
  return value?.message || "Web request failed";
}

export async function readWithWebFallback<T>(
  first: () => Promise<T>, second: () => Promise<T>, errors: string[],
): Promise<T> {
  try { return await first(); }
  catch (error) { errors.push(describeWebFailure(error)); }
  try { return await second(); }
  catch (error) {
    errors.push(describeWebFailure(error));
    throw new Error(`Web sources unavailable; both methods failed: ${errors.join("; ")}. Coverage is incomplete, not evidence of no new content.`);
  }
}
