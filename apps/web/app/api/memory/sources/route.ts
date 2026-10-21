import { requireMemoryUser, errorResponse } from "../owner-route-helpers";
import { inspectMemorySources } from "@/lib/memory/sources/inspection";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const owner = await requireMemoryUser(); if (owner.error) return owner.error;
  const parameters = new URL(request.url).searchParams;
  if ([...parameters.keys()].some(key => key !== "limit" || parameters.getAll(key).length !== 1)) return Response.json({ code: "invalid_memory_request" }, { status: 400 });
  try { return Response.json(await inspectMemorySources(owner.userId, parameters.has("limit") ? Number(parameters.get("limit")) : 20), { headers: { "Cache-Control": "private, no-store" } }); }
  catch (error) { return errorResponse(error, "Source coverage is temporarily unavailable"); }
}
