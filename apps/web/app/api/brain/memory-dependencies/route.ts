import { NextResponse, type NextRequest } from "next/server";
import { listMemoryDependencyImpacts, MemoryDependencyError } from "@/lib/brain/memory-dependencies";
import { errorResponse, parseLimit, requireBrainUser } from "../_shared";

export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  const user = await requireBrainUser();
  if (user.error) return user.error;
  try {
    const p = request.nextUrl.searchParams;
    return NextResponse.json(await listMemoryDependencyImpacts({ requester: { type: "chat", userId: user.userId, id: "brain-dependency-api" }, sourceMemoryId: p.get("sourceMemoryId") ?? undefined, workId: p.get("workId") ?? undefined, limit: parseLimit(p.get("limit"), 20), cursor: p.get("cursor") ?? undefined }));
  } catch (error) {
    return error instanceof MemoryDependencyError ? NextResponse.json({ error: error.message, code: error.code }, { status: error.status }) : errorResponse(error, "Failed to list memory dependencies");
  }
}
