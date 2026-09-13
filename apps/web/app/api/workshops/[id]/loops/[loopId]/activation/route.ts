import { auth } from "@/app/(auth)/auth";
import { updateWorkLoopActivation } from "@/lib/work-runtime";
import { NextResponse, type NextRequest } from "next/server";
import {WorkCommandConflict} from "@/lib/work-runtime/command-ledger";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; loopId: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (request.headers.has('X-Work-Actor') && request.headers.get('X-Work-Actor') !== session.user.id) return NextResponse.json({error:'actor_changed'}, {status:409});
    const { id, loopId } = await params;
    const body = await request.json().catch(() => ({}));
    const action = body?.action;

    if (action === "activate") {
      const { loop } = await updateWorkLoopActivation({
        commandId: body.commandId ?? request.headers.get("Idempotency-Key") ?? undefined,
        expectedVersion: body.expectedVersion,
        userId: session.user.id,
        workId: id,
        loopId,
        action: "activate",
        source: "owner",
        reason: typeof body?.reason === "string" ? body.reason : null,
      });
      return NextResponse.json({ loop });
    }

    if (action === "reject") {
      const { loop } = await updateWorkLoopActivation({
        commandId: body.commandId ?? request.headers.get("Idempotency-Key") ?? undefined,
        expectedVersion: body.expectedVersion,
        userId: session.user.id,
        workId: id,
        loopId,
        action: "reject",
        source: "owner",
        rejectionReason: typeof body?.reason === "string" ? body.reason : null,
      });
      return NextResponse.json({ loop });
    }

    return NextResponse.json(
      { error: "action must be activate or reject" },
      { status: 400 },
    );
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to update workshop loop activation";
    const status = error instanceof WorkCommandConflict ? error.status : /not found/i.test(message) ? 404 : 500;
    console.error("[WorkshopLoopActivationAPI] POST error:", error);
    return NextResponse.json({ error: message }, { status });
  }
}
