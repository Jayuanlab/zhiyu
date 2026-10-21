import { readOwnerMutation } from "@/app/api/memory/owner-request-schemas";
import { NextResponse, type NextRequest } from "next/server";
import { reviewMemory as reviewBrainMemory } from "@/lib/memory/revision/writes";
import { BrainMemoryReviewConflict } from "@/lib/memory/revision/review";
import { errorResponse, requireMemoryUser } from "@/app/api/memory/owner-route-helpers";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireMemoryUser();
  if (user.error) return user.error;
  try {
    const { id } = await params;
    const body = await readOwnerMutation(request, "review");
    const memory = await reviewBrainMemory({
      requester: { type: "chat", userId: user.userId, id: "brain-api" },
      memoryId: id,
      decision: body.decision,
      reason: typeof body.reason === "string" ? body.reason : null,
      expectedVersion: typeof body.expectedVersion === "string" ? body.expectedVersion : undefined,
      evidenceConfirmed: body.evidenceConfirmed === true,
    });
    return NextResponse.json({ memory });
  } catch (error) {
    if (error instanceof BrainMemoryReviewConflict) {
      return NextResponse.json({error: error.message, code: error.code}, {status: error.status});
    }
    return errorResponse(error, "Failed to review Brain candidate");
  }
}
