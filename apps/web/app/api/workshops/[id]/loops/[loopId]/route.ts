import { auth } from "@/app/(auth)/auth";
import { clearWorkLoopBlocker, updateWorkLoop } from "@/lib/work-runtime";
import { NextResponse, type NextRequest } from "next/server";

export const dynamic = "force-dynamic";

function statusFromAction(action: unknown) {
  if (action === "pause") return "paused";
  if (action === "resume") return "active";
  return null;
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; loopId: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id, loopId } = await params;
    const body = await request.json().catch(() => ({}));
    if (body?.action === "clear_blocker") {
      const result = await clearWorkLoopBlocker({
        userId: session.user.id,
        workId: id,
        loopId,
        patch: {},
        source: "owner",
        reason:
          typeof body?.reason === "string"
            ? body.reason
            : "Owner dismissed blocker without rerun from attention center",
      });
      return NextResponse.json({ loop: result.loop, cleared: true });
    }

    const status = statusFromAction(body?.action);

    if (!status) {
      return NextResponse.json(
        { error: "action must be pause, resume, or clear_blocker" },
        { status: 400 },
      );
    }

    const { loop } = await updateWorkLoop({
      userId: session.user.id,
      workId: id,
      loopId,
      patch: { status },
      source: "owner",
      reason:
        typeof body?.reason === "string"
          ? body.reason
          : `Owner changed loop status to ${status}`,
    });

    return NextResponse.json({ loop });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to update workshop loop";
    const status = /not found/i.test(message) ? 404 : 400;
    console.error("[WorkshopLoopAPI] PATCH error:", error);
    return NextResponse.json({ error: message }, { status });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; loopId: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id, loopId } = await params;
    const body = await request.json().catch(() => ({}));
    const { loop } = await updateWorkLoop({
      userId: session.user.id,
      workId: id,
      loopId,
      patch: { status: "archived" },
      source: "owner",
      reason:
        typeof body?.reason === "string"
          ? body.reason
          : "Owner archived loop from workshop UI",
    });

    return NextResponse.json({ loop, archived: true });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to delete workshop loop";
    const status = /not found/i.test(message) ? 404 : 400;
    console.error("[WorkshopLoopAPI] DELETE error:", error);
    return NextResponse.json({ error: message }, { status });
  }
}
