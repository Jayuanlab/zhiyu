import { auth } from "@/app/(auth)/auth";
import { NextResponse, type NextRequest } from "next/server";
import {
  actOnCollaborationRequest, CollaborationError, getCollaborationRequest,
  queueCollaborationDelivery,
} from "@/lib/workshops/collaboration";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string; requestId: string }> };
function failure(error: unknown) {
  if (error instanceof CollaborationError) return NextResponse.json({ error: error.code }, { status: error.statusCode });
  console.error("[CollaborationRequestAPI]", error);
  return NextResponse.json({ error: "collaboration_unavailable" }, { status: 500 });
}

export async function GET(_request: NextRequest, { params }: Context) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const { id, requestId } = await params;
    return NextResponse.json(await getCollaborationRequest(session.user.id, id, requestId),
      { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return failure(error); }
}

export async function POST(request: NextRequest, { params }: Context) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const { id, requestId } = await params;
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    }
    const commandId = body.commandId ?? request.headers.get("Idempotency-Key") ?? "";
    const result = body.action === "queue_delivery"
      ? await queueCollaborationDelivery({
        ownerId: session.user.id, requesterWorkId: id, requestId,
        expectedVersion: body.expectedVersion, commandId,
        confirmedNoEffect: body.confirmedNoEffect, evidence: body.evidence,
      })
      : await actOnCollaborationRequest({
        ownerId: session.user.id, workId: id, requestId,
        action: body.action, expectedVersion: body.expectedVersion,
        commandId, detail: body.detail, actorType: "owner",
      });
    return NextResponse.json({ request: result });
  } catch (error) { return failure(error); }
}
