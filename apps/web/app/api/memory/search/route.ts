import { auth } from "@/app/(auth)/auth";
import { extractCloudAuthToken } from "@/lib/ai/request-context";
import { cachedUnifiedMemorySearch } from "@/lib/memory/search-cache";
import { finalizeOwnerDiscovery } from "@/lib/memory/retrieval/compatibility-discovery";
import { MemoryModuleError } from "@/lib/memory/kernel/errors";
import {
  clampUnifiedMemorySearchLimit,
  clampUnifiedMemorySearchThreshold,
  normalizeUnifiedMemorySearchSources,
  searchUnifiedMemory,
} from "@/lib/memory/unified-search";
import { AppError } from "@openzhiyu/shared/errors";
import type { NextRequest } from "next/server";
import { readBoundedJson } from "../_shared";

function parseStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return new AppError("unauthorized:auth").toResponse();
  }

  try {
    const body = await readBoundedJson(request) as Record<string, unknown>;
    if (!body || typeof body !== "object" || Array.isArray(body) || body.purpose !== undefined && body.purpose !== "discover"
      || Object.keys(body).some(key => !["purpose", "query", "sources", "limit", "threshold", "botIds", "documentIds", "includeArchivedInsights"].includes(key))
      || body.sources !== undefined && (!Array.isArray(body.sources) || !body.sources.length || body.sources.some((value: unknown) => typeof value !== "string" || !["memory", "insights", "knowledge", "interactions", "graph"].includes(value))))
      return new AppError("bad_request:api", "Choose explicit supported discovery sources; task recall uses /api/memory/read.").toResponse();
    const query = typeof body.query === "string" ? body.query.trim() : "";
    if (!query || query.length > 2000) {
      return new AppError(
        "bad_request:api",
        "Query must be a non-empty string of at most 2000 characters.",
      ).toResponse();
    }

    const searchInput = {
      userId: session.user.id,
      query,
      sources: normalizeUnifiedMemorySearchSources(body.sources),
      limit: clampUnifiedMemorySearchLimit(body.limit),
      threshold: clampUnifiedMemorySearchThreshold(body.threshold),
      botIds: parseStringArray(body.botIds),
      documentIds: parseStringArray(body.documentIds),
      includeLegacyMemory: false,
      includeArchivedInsights: body.includeArchivedInsights === true,
      authToken: extractCloudAuthToken(request),
    };

    // Canonical versions and natural expiry cannot be authorized by the old
    // count/max-timestamp cache stamp. Always read them afresh and receipt them.
    const result = searchInput.sources.includes("memory") ? await searchUnifiedMemory(searchInput)
      : await cachedUnifiedMemorySearch(searchInput, () => searchUnifiedMemory(searchInput));
    return Response.json(await finalizeOwnerDiscovery(session.user.id, result), { status: 200 });
  } catch (error) {
    if (error instanceof SyntaxError) return new AppError("bad_request:api", "A JSON discovery request is required.").toResponse();
    if (error instanceof MemoryModuleError) return Response.json({ error: "Memory discovery is unavailable", code: error.code }, { status: error.status });
    console.error("[MemorySearch] Unified search failed", { code: "memory_discovery_unavailable" });
    return Response.json({ error: "Memory discovery is unavailable", code: "memory_discovery_unavailable" }, { status: 503 });
  }
}
