import { requireMemoryUser, errorResponse } from "@/app/api/memory/owner-route-helpers";
import { readBoundedJson } from "@/app/api/memory/_shared";
import { rebaseLegacyMemoryPlan } from "@/lib/memory/plans/service";
export const dynamic = "force-dynamic";
export async function POST(request: Request, { params }: { params: Promise<{ planId: string }> }) {
  const owner = await requireMemoryUser(); if (owner.error) return owner.error;
  try {
    return Response.json(await rebaseLegacyMemoryPlan(owner.userId, (await params).planId, await readBoundedJson(request)), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return errorResponse(error, "Plan recovery could not be confirmed"); }
}
