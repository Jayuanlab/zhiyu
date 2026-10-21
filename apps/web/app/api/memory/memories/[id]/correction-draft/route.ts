import { readBoundedJson } from "@/app/api/memory/_shared";
import { NextResponse, type NextRequest } from "next/server";
import { BrainMemoryCorrectionDraftError, createBrainMemoryCorrectionDraft, getBrainMemoryCorrectionDraft } from "@/lib/memory/revision/correction-draft";
import { errorResponse, requireMemoryUser } from "@/app/api/memory/owner-route-helpers";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
function failure(error: unknown) {
  if (error instanceof BrainMemoryCorrectionDraftError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status, headers });
  return errorResponse(error, "Correction draft is unavailable");
}
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireMemoryUser();
  if (user.error) return user.error;
  try {
    return NextResponse.json(await createBrainMemoryCorrectionDraft({ requester: { type: "chat", userId: user.userId, id: "brain-correction-api" },
      memoryId: (await params).id, request: await readBoundedJson(request) }), { headers });
  } catch (error) { return failure(error); }
}
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireMemoryUser();
  if (user.error) return user.error;
  try {
    return NextResponse.json(await getBrainMemoryCorrectionDraft({ requester: { type: "chat", userId: user.userId, id: "brain-correction-api" },
      memoryId: (await params).id, commandId: request.nextUrl.searchParams.get("commandId") ?? "" }), { headers });
  } catch (error) { return failure(error); }
}
