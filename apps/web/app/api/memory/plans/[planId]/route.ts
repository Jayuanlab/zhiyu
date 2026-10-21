import { requireMemoryUser, errorResponse } from "@/app/api/memory/owner-route-helpers";
import { inspectMemoryPlan } from "@/lib/memory/plans/service";
export const dynamic = "force-dynamic";
export async function GET(request: Request, { params }: { params: Promise<{ planId: string }> }) {
  const owner = await requireMemoryUser(); if (owner.error) return owner.error;
  if ([...new URL(request.url).searchParams.keys()].length) return Response.json({ code: "invalid_memory_request" }, { status: 400 });
  try {
    return Response.json(await inspectMemoryPlan(owner.userId, (await params).planId), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return errorResponse(error, "Plan inspection is temporarily unavailable"); }
}
