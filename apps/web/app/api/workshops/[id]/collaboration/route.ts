import { auth } from "@/app/(auth)/auth";
import { NextResponse, type NextRequest } from "next/server";
import {
  CollaborationError, createCollaborationRequest,
  listCollaborationPeers, listCollaborationRequests,
} from "@/lib/workshops/collaboration";

export const dynamic = "force-dynamic";

function failure(error: unknown) {
  if (error instanceof CollaborationError) {
    return NextResponse.json({ error: error.code }, { status: error.statusCode });
  }
  console.error("[CollaborationAPI]", error);
  return NextResponse.json({ error: "collaboration_unavailable" }, { status: 500 });
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const { id } = await params;
    const [requests, peers] = await Promise.all([
      listCollaborationRequests(session.user.id, id),
      listCollaborationPeers(session.user.id, id),
    ]);
    return NextResponse.json({ requests, peers }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return failure(error); }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const { id } = await params;
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    }
    const created = await createCollaborationRequest({
      ownerId: session.user.id,
      requesterWorkId: id,
      recipientWorkId: body.recipientWorkId,
      kind: body.kind,
      neededCapability: body.neededCapability,
      problem: body.problem,
      desiredOutcome: body.desiredOutcome,
      whyHelpNeeded: body.whyHelpNeeded,
      acceptanceCriteria: body.acceptanceCriteria,
      sourceEventIds: body.sourceEventIds,
      originRunId: body.originRunId,
      originLoopId: body.originLoopId,
      commandId: body.commandId ?? request.headers.get("Idempotency-Key") ?? "",
      actorType: "owner",
    });
    return NextResponse.json({ request: created }, { status: 201 });
  } catch (error) { return failure(error); }
}
