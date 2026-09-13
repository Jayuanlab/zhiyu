import { auth } from "@/app/(auth)/auth";
import {
  addWorkDirective,
  listWorkDirectives,
} from "@/lib/work-runtime";
import { NextResponse, type NextRequest } from "next/server";
import { WorkCommandConflict } from "@/lib/work-runtime/command-ledger";

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
    return NextResponse.json({
      directives: await listWorkDirectives({
        userId: session.user.id,
        workId: id,
      }),
    });
  } catch (error) {
    console.error("[WorkshopDirectivesAPI] GET error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load directives" },
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
    const content = String(body.content ?? "").trim();
    if (!content) {
      return NextResponse.json(
        { error: "content is required" },
        { status: 400 },
      );
    }

    const result = await addWorkDirective({
      userId: session.user.id,
      workId: id,
      runId: body.runId ?? null,
      commandId: body.commandId ?? request.headers.get("Idempotency-Key") ?? undefined,
      expectedVersion: body.expectedVersion,
      content,
      priority: Number(body.priority ?? 0),
      scope: body.scope ?? "current_run",
      triggerRun: body.triggerRun !== false,
      source: "owner",
      reason: "Directive added from workshop API.",
    });

    return NextResponse.json(
      {
        directive: result.directive,
        run: result.run,
        runError: result.runError,
      },
      { status: 201 },
    );
  } catch (error) {
    console.error("[WorkshopDirectivesAPI] POST error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to add directive" },
      { status: error instanceof WorkCommandConflict ? error.status : 500 },
    );
  }
}
