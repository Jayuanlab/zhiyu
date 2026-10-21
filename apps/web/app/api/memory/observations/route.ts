import { readOwnerMutation } from "@/app/api/memory/owner-request-schemas";
import { NextResponse, type NextRequest } from "next/server";
import { createObservation as createBrainObservation, listObservations as listBrainObservations } from "@/lib/memory";
import { errorResponse, parseCsv, parseLimit, requireMemoryUser } from "@/app/api/memory/owner-route-helpers";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const user = await requireMemoryUser();
  if (user.error) return user.error;
  try {
    const params = request.nextUrl.searchParams;
    const observations = await listBrainObservations({
      userId: user.userId,
      sourceTypes: parseCsv(params.get("sourceTypes")),
      limit: parseLimit(params.get("limit")),
    });
    return NextResponse.json({ observations });
  } catch (error) {
    return errorResponse(error, "Failed to list Brain observations");
  }
}

export async function POST(request: NextRequest) {
  const user = await requireMemoryUser();
  if (user.error) return user.error;
  try {
    const body = await readOwnerMutation(request, "observation");
    const observation = await createBrainObservation({
      userId: user.userId,
      sourceType: String(body.sourceType ?? "manual"),
      sourceId: String(body.sourceId ?? crypto.randomUUID()),
      sourceEventId: typeof body.sourceEventId === "string" ? body.sourceEventId : null,
      observedAt: body.observedAt ?? new Date().toISOString(),
      content: String(body.content ?? ""),
      trustLevel: typeof body.trustLevel === "string" ? body.trustLevel : "raw",
      metadata:
        body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
          ? body.metadata
          : {},
    });
    return NextResponse.json({ observation });
  } catch (error) {
    return errorResponse(error, "Failed to create Brain observation");
  }
}
