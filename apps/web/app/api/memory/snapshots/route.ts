import { readOwnerMutation } from "@/app/api/memory/owner-request-schemas";
import { NextResponse, type NextRequest } from "next/server";
import { createBrainStateSnapshot, listBrainSnapshots } from "@/lib/memory/continuity/state-snapshots";
import { errorResponse, parseCsv, parseLimit, parseScope, requireMemoryUser } from "@/app/api/memory/owner-route-helpers";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const user = await requireMemoryUser();
  if (user.error) return user.error;
  try {
    const params = request.nextUrl.searchParams;
    const snapshots = await listBrainSnapshots({
      userId: user.userId,
      snapshotTypes: parseCsv(params.get("snapshotTypes")),
      limit: parseLimit(params.get("limit")),
    });
    return NextResponse.json({ snapshots });
  } catch (error) {
    return errorResponse(error, "Failed to list Brain snapshots");
  }
}

export async function POST(request: NextRequest) {
  const user = await requireMemoryUser();
  if (user.error) return user.error;
  try {
    const body = await readOwnerMutation(request, "snapshot");
    const snapshot = await createBrainStateSnapshot({
      userId: user.userId,
      scope: parseScope(body.scope),
      snapshotType: String(body.snapshotType ?? "work_state"),
      content:
        body.content && typeof body.content === "object" && !Array.isArray(body.content)
          ? body.content
          : {},
      sourceMemoryIds: Array.isArray(body.sourceMemoryIds) ? body.sourceMemoryIds : [],
      metadata:
        body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
          ? body.metadata
          : {},
    });
    return NextResponse.json({ snapshot });
  } catch (error) {
    return errorResponse(error, "Failed to create Brain snapshot");
  }
}
