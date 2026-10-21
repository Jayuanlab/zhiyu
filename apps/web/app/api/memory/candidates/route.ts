import { readOwnerMutation } from "@/app/api/memory/owner-request-schemas";
import { NextResponse, type NextRequest } from "next/server";
import { listBrainCandidates } from "@/lib/memory/retrieval/queries";
import { createMemoryCandidate as createBrainMemoryCandidate } from "@/lib/memory/revision/writes";
import { errorResponse, parseLimit, parseScope, requireMemoryUser } from "@/app/api/memory/owner-route-helpers";
import type { BrainMemory } from "@/lib/memory/kernel/memory-types";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const user = await requireMemoryUser();
  if (user.error) return user.error;
  try {
    const params = request.nextUrl.searchParams;
    const candidates = await listBrainCandidates({
      userId: user.userId,
      limit: parseLimit(params.get("limit")),
      ownerType: (params.get("ownerType") as BrainMemory["ownerType"]) ?? undefined,
      ownerId: params.get("ownerId") ?? undefined,
    });
    return NextResponse.json({ candidates });
  } catch (error) {
    return errorResponse(error, "Failed to list Brain candidates");
  }
}

export async function POST(request: NextRequest) {
  const user = await requireMemoryUser();
  if (user.error) return user.error;
  try {
    const body = await readOwnerMutation(request, "memory");
    const candidate = await createBrainMemoryCandidate({
      requester: { type: "chat", userId: user.userId, id: "brain-api" },
      scope: parseScope(body.scope),
      ownerType: body.ownerType ?? "chat",
      ownerId: body.ownerId ?? user.userId,
      memoryType: body.memoryType ?? "fact",
      subject: String(body.subject ?? "Candidate"),
      content: String(body.content ?? ""),
      confidence: Number(body.confidence ?? 50),
      evidenceRefs: Array.isArray(body.evidenceRefs) ? body.evidenceRefs : [],
      tags: Array.isArray(body.tags) ? body.tags : [],
    });
    return NextResponse.json({ candidate });
  } catch (error) {
    return errorResponse(error, "Failed to create Brain candidate");
  }
}
