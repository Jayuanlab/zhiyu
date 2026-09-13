export type AuthMode = "local_owner" | "authenticated";

export function getAuthMode(value = process.env.AUTH_MODE): AuthMode {
  if (!value || value === "authenticated") return "authenticated";
  if (value === "local_owner") return "local_owner";
  throw new Error("AUTH_MODE must be local_owner or authenticated");
}

export function isLoopbackHostname(hostname: string): boolean {
  return ["127.0.0.1", "localhost", "[::1]", "::1"].includes(hostname.toLowerCase());
}

/** Browser boundary only. A successful check does not grant resource ownership. */
export function requestBoundary(request: Request, mode: AuthMode): string | null {
  const url = new URL(request.url);
  // Next's image optimizer reads public assets internally without browser Host.
  // This is not an API exemption and never permits an asset-path write.
  if (["GET", "HEAD"].includes(request.method) && /^\/(images|icons|fonts)\/.+\.(png|jpe?g|webp|gif|svg|ico|woff2?)$/i.test(url.pathname)) return null;
  const host = request.headers.get("host");
  if (!host) return "untrusted_host";
  let hostUrl: URL;
  try { hostUrl = new URL(`${url.protocol}//${host}`); } catch { return "untrusted_host"; }
  if (hostUrl.host.toLowerCase() !== host.toLowerCase()) return "untrusted_host";
  // NextURL normalizes 127.0.0.1/[::1] to localhost; ports must still match.
  const normalizedLoopback = isLoopbackHostname(url.hostname) && isLoopbackHostname(hostUrl.hostname) && url.port === hostUrl.port;
  if (hostUrl.host.toLowerCase() !== url.host.toLowerCase() && !normalizedLoopback) return "untrusted_host";
  if (mode === "local_owner" && !isLoopbackHostname(url.hostname)) return "local_owner_requires_loopback";
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return null;
  if (request.headers.get("sec-fetch-site") === "cross-site") return "cross_site_write";
  const origin = request.headers.get("origin");
  if (!origin || origin !== hostUrl.origin) return "same_origin_required";
  return null;
}
