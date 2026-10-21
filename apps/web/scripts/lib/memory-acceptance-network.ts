import { lookup } from "node:dns/promises";
import { isIPv4 } from "node:net";
import { performance } from "node:perf_hooks";
import { Agent } from "undici";

const TARGET_ORIGIN = "https://opencode.ai";
const PREFLIGHT_URL = `${TARGET_ORIGIN}/zen/go/v1/chat/completions`;
const MAX_ADDRESSES = 4;
const PREFLIGHT_TIMEOUT_MS = 5_000;

export type MemoryAcceptanceNetworkMode =
  | "default"
  | "verified-direct-opencode";

export interface MemoryAcceptanceNetworkMetadata {
  mode: MemoryAcceptanceNetworkMode;
  preparedAtUtc: string;
  targetOrigin: typeof TARGET_ORIGIN;
  scope: "unchanged" | "isolated-process-target-origin-only";
  preferredAddress: string | null;
  selectedAddress: string | null;
  certificateValidation: true;
  originalHostnameAndSniPreserved: true;
  processEnvironmentChanged: false;
  globalDispatcherChanged: false;
  preflightModelRequests: 0;
  publicIpv4Candidates: string[];
  preflight: Array<{
    address: string;
    transportSucceeded: boolean;
    elapsedMs: number;
    status?: number;
    errorCode?: string;
  }>;
}

export interface MemoryAcceptanceNetwork {
  metadata: MemoryAcceptanceNetworkMetadata;
  apply(url: URL, init: RequestInit | undefined): RequestInit | undefined;
  close(): Promise<void>;
}

export class MemoryAcceptanceNetworkError extends Error {
  constructor(
    message: string,
    readonly metadata: MemoryAcceptanceNetworkMetadata,
  ) {
    super(message);
    this.name = "MemoryAcceptanceNetworkError";
  }
}

function isPublicIpv4(address: string): boolean {
  if (!isIPv4(address)) return false;
  const [a, b, c] = address.split(".").map(Number);
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function safeErrorCode(error: unknown): string {
  if (!error || typeof error !== "object") return "NETWORK_ERROR";
  const wrapped = error as {
    code?: unknown;
    name?: unknown;
    cause?: { code?: unknown; name?: unknown };
  };
  const code = [wrapped.cause?.code, wrapped.code, wrapped.name].find(
    (value): value is string =>
      typeof value === "string" && /^[A-Za-z0-9_]+$/.test(value),
  );
  return code ?? "NETWORK_ERROR";
}

function pinnedAgent(address: string): Agent {
  return new Agent({
    connect: {
      timeout: PREFLIGHT_TIMEOUT_MS,
      autoSelectFamily: false,
      // Resolve only the target hostname here. The URL and TLS servername stay
      // opencode.ai, with normal certificate validation still enabled.
      lookup(hostname, options, callback) {
        if (hostname !== "opencode.ai") {
          callback(new Error("Acceptance dispatcher is restricted to opencode.ai"), "", 4);
          return;
        }
        if (options.all) callback(null, [{ address, family: 4 }]);
        else callback(null, address, 4);
      },
    },
  });
}

/**
 * Explicit, temporary transport selection for isolated memory acceptance runs.
 * This performs no authenticated requests and changes no shared network state.
 */
export async function prepareMemoryAcceptanceNetwork(
  mode: MemoryAcceptanceNetworkMode,
  options?: { preferredAddress?: string },
): Promise<MemoryAcceptanceNetwork> {
  const preferredAddress = options?.preferredAddress;
  const metadata: MemoryAcceptanceNetworkMetadata = {
    mode,
    preparedAtUtc: new Date().toISOString(),
    targetOrigin: TARGET_ORIGIN,
    scope: mode === "default" ? "unchanged" : "isolated-process-target-origin-only",
    preferredAddress: null,
    selectedAddress: null,
    certificateValidation: true,
    originalHostnameAndSniPreserved: true,
    processEnvironmentChanged: false,
    globalDispatcherChanged: false,
    preflightModelRequests: 0,
    publicIpv4Candidates: [],
    preflight: [],
  };

  if (preferredAddress !== undefined) {
    if (mode !== "verified-direct-opencode") {
      throw new MemoryAcceptanceNetworkError(
        "A preferred address requires verified-direct-opencode mode",
        metadata,
      );
    }
    if (typeof preferredAddress !== "string" || !isPublicIpv4(preferredAddress)) {
      throw new MemoryAcceptanceNetworkError(
        "The preferred address must be a public IPv4 address",
        metadata,
      );
    }
    metadata.preferredAddress = preferredAddress;
  }

  if (mode === "default") {
    return {
      metadata,
      apply: (_url, init) => init,
      close: async () => {},
    };
  }
  if (mode !== "verified-direct-opencode") {
    throw new Error("Unsupported memory acceptance network mode");
  }

  try {
    const addresses = await lookup("opencode.ai", { all: true });
    const publicAddresses = [
      ...new Set(addresses.filter(({ family, address }) => family === 4 && isPublicIpv4(address)).map(({ address }) => address)),
    ];
    // Validate against the entire current answer before the four-address cap.
    // A caller cannot inject an arbitrary address for the target origin.
    if (preferredAddress !== undefined && !publicAddresses.includes(preferredAddress)) {
      throw new MemoryAcceptanceNetworkError(
        "The preferred address is not a current public IPv4 DNS candidate for opencode.ai",
        metadata,
      );
    }
    metadata.publicIpv4Candidates = (preferredAddress === undefined
      ? publicAddresses
      : [preferredAddress, ...publicAddresses.filter((address) => address !== preferredAddress)]
    ).slice(0, MAX_ADDRESSES);
  } catch (error) {
    if (error instanceof MemoryAcceptanceNetworkError) throw error;
    throw new MemoryAcceptanceNetworkError(
      `Memory acceptance DNS lookup failed (${safeErrorCode(error)})`,
      metadata,
    );
  }

  for (const address of metadata.publicIpv4Candidates) {
    const dispatcher = pinnedAgent(address);
    const started = performance.now();
    let selected = false;
    try {
      const init: RequestInit & { dispatcher: Agent } = {
        method: "HEAD",
        redirect: "manual",
        signal: AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS),
        dispatcher,
      };
      const response = await fetch(PREFLIGHT_URL, init);
      await response.body?.cancel();
      // Any HTTP response, including 401/404, proves TLS transport reachability.
      // It does not establish model authorization, completion or streaming.
      metadata.preflight.push({
        address,
        transportSucceeded: true,
        status: response.status,
        elapsedMs: Math.round(performance.now() - started),
      });
      metadata.selectedAddress = address;
      selected = true;
      let closing: Promise<void> | undefined;
      return {
        metadata,
        apply(url, requestInit) {
          if (url.origin !== TARGET_ORIGIN) return requestInit;
          if (closing) throw new Error("Memory acceptance dispatcher has been closed");
          const overridden: RequestInit & { dispatcher: Agent } = {
            ...requestInit,
            dispatcher,
          };
          return overridden;
        },
        close() {
          closing ??= dispatcher.close();
          return closing;
        },
      };
    } catch (error) {
      metadata.preflight.push({
        address,
        transportSucceeded: false,
        elapsedMs: Math.round(performance.now() - started),
        errorCode: safeErrorCode(error),
      });
    } finally {
      if (!selected) await dispatcher.destroy();
    }
  }

  throw new MemoryAcceptanceNetworkError(
    "No public IPv4 candidate passed the unauthenticated opencode.ai TLS preflight",
    metadata,
  );
}
