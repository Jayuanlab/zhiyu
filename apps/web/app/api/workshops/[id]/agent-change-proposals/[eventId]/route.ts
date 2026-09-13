import { auth } from "@/app/(auth)/auth";
import {
  resolveWorkAgentChangeProposal,
} from "@/lib/work-runtime";
import {
  WorkshopAgentChangeStaleProposalError,
} from "@/lib/workshops/agent-change-proposals";
import { NextResponse, type NextRequest } from "next/server";
import {WorkCommandConflict} from "@/lib/work-runtime/command-ledger";

export const dynamic = "force-dynamic";

function parseAction(value: unknown) {
  return value === "apply" || value === "reject" || value === "recreate"
    ? value
    : null;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; eventId: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (request.headers.has('X-Work-Actor') && request.headers.get('X-Work-Actor') !== session.user.id) return NextResponse.json({error:'actor_changed'}, {status:409});
    const { id, eventId } = await params;
    const body = (await request.json().catch(() => ({}))) as {
      action?: unknown;
      reason?: unknown;
      commandId?: string;
      expectedVersion?: number;
    };
    const action = parseAction(body.action);
    if (!action) {
      return NextResponse.json(
        { error: "action must be apply, reject, or recreate" },
        { status: 400 },
      );
    }

    const result = await resolveWorkAgentChangeProposal({
      userId: session.user.id,
      workId: id,
      proposalEventId: eventId,
      action,
      reason: typeof body.reason === "string" ? body.reason : null,
      source: "owner",
      commandId: body.commandId ?? request.headers.get("Idempotency-Key") ?? undefined,
      expectedVersion: body.expectedVersion,
    });

    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    console.error("[WorkshopAgentChangeProposalAPI] POST error:", error);
    const isStale = error instanceof WorkshopAgentChangeStaleProposalError;
    return NextResponse.json(
      {
        ok: false,
        code: error instanceof WorkCommandConflict ? error.code : isStale ? error.code : "WORKSHOP_AGENT_CHANGE_RESOLVE_FAILED",
        error:
          error instanceof Error
            ? error.message
            : "Failed to resolve workshop agent change proposal",
      },
      { status: error instanceof WorkCommandConflict ? error.status : isStale ? 409 : 500 },
    );
  }
}
