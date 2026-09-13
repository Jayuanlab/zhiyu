import { auth } from "@/app/(auth)/auth";
import { startWorkRun, listWorkRuns } from "@/lib/work-runtime";
import { WorkCommandConflict } from "@/lib/work-runtime/command-ledger";
import { NextResponse, type NextRequest } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, {params}: {params: Promise<{id: string}>}) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({error: "Unauthorized"}, {status: 401});
  const {id} = await params;
  const raw = request.nextUrl.searchParams.get("limit");
  const limit = raw === null ? 20 : Number(raw);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return NextResponse.json({error: "limit must be 1..100"}, {status: 400});
  const result = await listWorkRuns({userId: session.user.id, workId: id, limit});
  return result ? NextResponse.json(result) : NextResponse.json({error: "Workshop not found"}, {status: 404});
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
    const body = await request.json().catch(() => ({}));
    const { run, workshop } = await startWorkRun({
      userId: session.user.id,
      workId: id,
      commandId: body.commandId ?? request.headers.get("Idempotency-Key") ?? undefined,
      expectedVersion: body.expectedVersion,
      triggerReason: body.triggerReason ?? { type: "manual" },
      source: "owner",
      reason: typeof body.reason === "string" ? body.reason : null,
    });

    return NextResponse.json({ run, workshop }, { status: 202 });
  } catch (error) {
    console.error("[WorkshopRunsAPI] POST error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to start workshop run" },
      { status: error instanceof WorkCommandConflict ? error.status : 500 },
    );
  }
}
