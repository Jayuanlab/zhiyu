import { auth } from "@/app/(auth)/auth";
import { WorkCommandConflict } from "@/lib/work-runtime/command-ledger";
import {
  getWorkModelSnapshot,
  restoreWorkVersion,
} from "@/lib/work-runtime";
import { NextResponse, type NextRequest } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;
    const snapshot = await getWorkModelSnapshot({
      userId: session.user.id,
      workId: id,
    });
    if (!snapshot) {
      return NextResponse.json(
        { error: "Workshop not found" },
        { status: 404 },
      );
    }

    return NextResponse.json({
      versions: snapshot.versions,
      interfaceVersion: snapshot.interfaceVersion,
      generatedAt: snapshot.generatedAt,
    });
  } catch (error) {
    console.error("[WorkshopWorkVersionsAPI] GET error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to load Work versions",
      },
      { status: 500 },
    );
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (request.headers.has('X-Work-Actor') && request.headers.get('X-Work-Actor') !== session.user.id) return NextResponse.json({error:'actor_changed'}, {status:409});
    const { id } = await params;
    const body = await request.json();
    if (body?.action !== "restore" || typeof body?.versionId !== "string") {
      return NextResponse.json(
        { error: "action must be restore and versionId is required" },
        { status: 400 },
      );
    }

    const result = await restoreWorkVersion({
      userId: session.user.id,
      workId: id,
      commandId: body.commandId ?? request.headers.get("Idempotency-Key") ?? undefined,
      expectedVersion: body.expectedVersion,
      versionId: body.versionId,
      source: "owner",
      reason: typeof body.reason === "string" ? body.reason : null,
    });

    return NextResponse.json(result);
  } catch (error) {
    console.error("[WorkshopWorkVersionsAPI] POST error:", error);
    if (error instanceof WorkCommandConflict) return NextResponse.json({error: error.code}, {status: error.status});
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to restore Work version",
      },
      { status: 500 },
    );
  }
}
