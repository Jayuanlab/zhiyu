import { auth } from "@/app/(auth)/auth";
import { runWorkLoop,enqueueWorkLoop } from "@/lib/work-runtime";
import {WorkCommandConflict} from '@/lib/work-runtime/command-ledger';
import {LoopExecutionBusy} from '@/lib/work-runtime/loop-execution';
import {ExecutionLeaseError} from '@/lib/work-runtime/execution-errors';
import { NextResponse, type NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 800;

function resolveMode(value: unknown, dryRun: unknown) {
  if (dryRun === true || value === "dry_run") return "dry_run" as const;
  return "native_agent" as const;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; loopId: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if(request.headers.has('X-Work-Actor')&&request.headers.get('X-Work-Actor')!==session.user.id)return NextResponse.json({error:'actor_changed'},{status:409});
    const { id, loopId } = await params;
    const body = await request.json().catch(() => ({}));
    const mode = resolveMode(body?.mode, body?.dryRun);
    const waitForCompletion = body?.wait === true || mode === "dry_run";

    if (!waitForCompletion) {
      const queued=await enqueueWorkLoop({
        commandId:body.commandId??request.headers.get('Idempotency-Key')??undefined,
        expectedVersion:body.expectedVersion,
        userId: session.user.id,
        workId: id,
        loopId,
        mode,
        source: "owner",
        reason: "Manual loop execution from workshop API.",
        createOutboxDrafts:
          typeof body?.createOutboxDrafts === "boolean"
            ? body.createOutboxDrafts
            : undefined,
      });

      return NextResponse.json(
        {
          accepted: true,
          ...queued,
          workshopId: id,
          loopId,
          mode,
        },
        { status: 202 },
      );
    }

    const output = await runWorkLoop({
      commandId:body.commandId??request.headers.get('Idempotency-Key')??undefined,
      expectedVersion:body.expectedVersion,
      userId: session.user.id,
      workId: id,
      loopId,
      mode,
      source: "owner",
      reason: "Manual loop execution from workshop API.",
      createOutboxDrafts:
        mode === "dry_run"
          ? false
          : typeof body?.createOutboxDrafts === "boolean"
            ? body.createOutboxDrafts
            : undefined,
    });

    return NextResponse.json(output);
  } catch (error) {
    if(error instanceof WorkCommandConflict||error instanceof LoopExecutionBusy||error instanceof ExecutionLeaseError)return NextResponse.json({error:error.message,code:error.code},{status:error.status});
    const message =
      error instanceof Error ? error.message : "Failed to execute workshop loop";
    const status = /not found/i.test(message) ? 404 : 500;
    console.error("[WorkshopLoopExecuteAPI] POST error:", error);
    return NextResponse.json({ error: message }, { status });
  }
}
