import { NextResponse, type NextRequest } from "next/server";
import { reviewBrainMemory } from "@/lib/brain/service";
import { errorResponse, requireBrainUser } from "../../../_shared";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireBrainUser();
  if (user.error) return user.error;
  try {
    const { id } = await params;
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body) ||
      !["confirmed", "dismissed", "rejected", "active", "weakened"].includes(body.decision)) {
      return NextResponse.json({error: "Invalid review decision", code: "invalid_decision"}, {status: 400});
    }
    const memory = await reviewBrainMemory({
      requester: { type: "chat", userId: user.userId, id: "brain-api" },
      memoryId: id,
      decision: body.decision,
      reason: typeof body.reason === "string" ? body.reason : null,
    });
    return NextResponse.json({ memory });
  } catch (error) {
    return errorResponse(error, "Failed to review Brain candidate");
  }
}
