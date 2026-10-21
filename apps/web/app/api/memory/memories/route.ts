import { readOwnerMutation } from "@/app/api/memory/owner-request-schemas";
import { NextResponse, type NextRequest } from "next/server";
import { listBrainMemoriesForUser as listBrainMemory } from "@/lib/memory/retrieval/candidates";
import { writeMemory as writeBrainMemory } from "@/lib/memory/revision/writes";
import {
  errorResponse,
  parseLimit,
  parseMemoryTypes,
  parseScope,
  parseStatuses,
  requireMemoryUser,
} from "@/app/api/memory/owner-route-helpers";
import type { BrainMemory } from "@/lib/memory/kernel/memory-types";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const user = await requireMemoryUser();
  if (user.error) return user.error;
  try {
    const params = request.nextUrl.searchParams;
    const memories = await listBrainMemory({
      userId: user.userId,
      limit: parseLimit(params.get("limit")),
      statuses: parseStatuses(params.get("statuses")),
      memoryTypes: parseMemoryTypes(params.get("memoryTypes")),
      ownerType: (params.get("ownerType") as BrainMemory["ownerType"]) ?? undefined,
      ownerId: params.get("ownerId") ?? undefined,
    });
    return NextResponse.json({ memories });
  } catch (error) {
    return errorResponse(error, "Failed to list Brain memories");
  }
}

export async function POST(request: NextRequest) {
  const user = await requireMemoryUser();
  if (user.error) return user.error;
  try {
    const body = await readOwnerMutation(request, "memory");
    const memory = await writeBrainMemory({
      requester: { type: "chat", userId: user.userId, id: "brain-api" },
      scope: parseScope(body.scope),
      ownerType: body.ownerType ?? "chat",
      ownerId: body.ownerId ?? user.userId,
      memoryType: body.memoryType ?? "fact",
      subject: String(body.subject ?? "Memory"),
      content: String(body.content ?? ""),
      status: body.status ?? "active",
      confidence: Number(body.confidence ?? 50),
      evidenceRefs: Array.isArray(body.evidenceRefs) ? body.evidenceRefs : [],
      tags: Array.isArray(body.tags) ? body.tags : [],
      expiresAt: typeof body.expiresAt === "string" ? body.expiresAt : undefined,
    });
    return NextResponse.json({ memory });
  } catch (error) {
    return errorResponse(error, "Failed to write Brain memory");
  }
}
