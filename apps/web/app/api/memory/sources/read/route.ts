import { requireMemoryUser, errorResponse } from "../../owner-route-helpers";
import { readBoundedJson } from "../../_shared";
import { memorySourceCatalog } from "@/lib/memory/sources/catalog";
import { readOwnerSource } from "@/lib/memory/sources/service";
import { MemoryModuleError } from "@/lib/memory/kernel/errors";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  const owner = await requireMemoryUser(); if (owner.error) return owner.error;
  try {
    const parsed = await readBoundedJson(request);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new MemoryModuleError("invalid_memory_request", 400, "A source request is required");
    const body = parsed as Record<string, unknown>, kinds = memorySourceCatalog().sources.map(source => source.kind);
    if (Object.keys(body).some(key => !["source", "id", "offset", "expectedHash", "expectedRevision"].includes(key))
      || !kinds.some(kind => kind === body.source) || typeof body.id !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(body.id)
      || body.offset !== undefined && (!Number.isSafeInteger(body.offset) || Number(body.offset) < 0)
      || body.expectedHash !== undefined && (typeof body.expectedHash !== "string" || !/^[a-f0-9]{64}$/.test(body.expectedHash))
      || body.expectedRevision !== undefined && (typeof body.expectedRevision !== "string" || !/^[a-z0-9_:.-]{1,256}$/i.test(body.expectedRevision)))
      throw new MemoryModuleError("invalid_memory_request", 400, "Invalid source identity or window");
    const source = kinds.find(kind => kind === body.source)!;
    const result = await readOwnerSource({ userId: owner.userId, source, id: body.id.toLowerCase(), offset: body.offset === undefined ? undefined : Number(body.offset),
      expectedHash: typeof body.expectedHash === "string" ? body.expectedHash : undefined,
      expectedRevision: typeof body.expectedRevision === "string" ? body.expectedRevision : undefined });
    return Response.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return errorResponse(error, "Source evidence is temporarily unavailable"); }
}
