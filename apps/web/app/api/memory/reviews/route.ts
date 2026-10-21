import { NextResponse, type NextRequest } from "next/server";
import { listBrainReviews } from "@/lib/memory/retrieval/queries";
import { errorResponse, parseLimit, requireMemoryUser } from "@/app/api/memory/owner-route-helpers";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const user = await requireMemoryUser();
  if (user.error) return user.error;
  try {
    const params = request.nextUrl.searchParams;
    const reviews = await listBrainReviews({
      userId: user.userId,
      memoryId: params.get("memoryId") ?? undefined,
      limit: parseLimit(params.get("limit")),
    });
    return NextResponse.json({ reviews });
  } catch (error) {
    return errorResponse(error, "Failed to list Brain reviews");
  }
}
