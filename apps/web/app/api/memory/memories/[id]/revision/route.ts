import { readBoundedJson } from "@/app/api/memory/_shared";
import { NextResponse, type NextRequest } from "next/server";
import { BrainMemoryRevisionError, getBrainMemoryForRevision, reviseBrainMemory } from "@/lib/memory/revision/revision";
import { errorResponse, requireMemoryUser } from "@/app/api/memory/owner-route-helpers";

export const dynamic = "force-dynamic";

function revisionError(error: unknown) {
  if (error instanceof BrainMemoryRevisionError) {
    return NextResponse.json({error: error.message, code: error.code,
      ...(error.currentVersion ? {currentVersion: error.currentVersion} : {})}, {status: error.status});
  }
  return errorResponse(error, "Failed to revise Brain memory");
}

export async function GET(_request: NextRequest, {params}: {params: Promise<{id: string}>}) {
  const user = await requireMemoryUser();
  if (user.error) return user.error;
  try {
    const {id} = await params;
    return NextResponse.json(await getBrainMemoryForRevision({userId: user.userId, memoryId: id}));
  } catch (error) { return revisionError(error); }
}

export async function POST(request: NextRequest, {params}: {params: Promise<{id: string}>}) {
  const user = await requireMemoryUser();
  if (user.error) return user.error;
  try {
    const {id} = await params;
    const body = await readBoundedJson(request);
    return NextResponse.json(await reviseBrainMemory({
      requester: {type: "chat", userId: user.userId, id: "brain-revision-api"}, memoryId: id, request: body,
    }));
  } catch (error) { return revisionError(error); }
}
