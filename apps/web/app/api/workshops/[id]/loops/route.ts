import { auth } from "@/app/(auth)/auth";
import { MemoryDependencyError } from "@/lib/memory/revision/dependencies-common";
import { MemoryWriteBusy as BrainMemoryWriteBusy } from "@/lib/memory/kernel/reference-errors";
import type { LoopTemplateId } from "@/lib/loops";
import {
  createWorkLoop,
  listWorkLoops,
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
    const { workshop, loops } = await listWorkLoops({
      userId: session.user.id,
      workId: id,
      limit: 200,
    });

    return NextResponse.json({ workshop, loops });
  } catch (error) {
    console.error("[WorkshopLoopsAPI] GET error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to list workshop loops",
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
    const body = await request.json().catch(() => ({}));
    const type = body?.type;

    if (type === "template") {
      if (typeof body.templateId !== "string" || !body.templateId.trim()) {
        return NextResponse.json(
          { error: "templateId is required" },
          { status: 400 },
        );
      }

      const result = await createWorkLoop({
        userId: session.user.id,
        workId: id,
        type: "template",
        memoryDependencies: body.memoryDependencies,
        commandId: body.commandId ?? request.headers.get("Idempotency-Key") ?? undefined,
        expectedVersion: body.expectedVersion,
        templateId: body.templateId as LoopTemplateId,
        templateInput:
          body.input && typeof body.input === "object" ? body.input : {},
        source: "owner",
        reason: typeof body.reason === "string" ? body.reason : null,
      });

      return NextResponse.json(result, { status: 201 });
    }

    if (type === "natural_language" || type === undefined) {
      const intent = body?.intent;
      if (typeof intent !== "string" || !intent.trim()) {
        return NextResponse.json(
          { error: "intent is required" },
          { status: 400 },
        );
      }

      const result = await createWorkLoop({
        userId: session.user.id,
        workId: id,
        type: "natural_language",
        memoryDependencies: body.memoryDependencies,
        commandId: body.commandId ?? request.headers.get("Idempotency-Key") ?? undefined,
        expectedVersion: body.expectedVersion,
        intent,
        timezone:
          typeof body?.timezone === "string" ? body.timezone : undefined,
        externalWriteMode:
          body?.externalWriteMode === "manual_approval"
            ? "manual_approval"
            : "loop_approved",
        create: body?.create === true,
        source: "owner",
        reason: typeof body.reason === "string" ? body.reason : null,
      });
      return NextResponse.json(result, { status: body?.create === true ? 201 : 200 });
    }

    return NextResponse.json(
      { error: "type must be template or natural_language" },
      { status: 400 },
    );
  } catch (error) {
    console.error("[WorkshopLoopsAPI] POST error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to create workshop loop",
        code: error instanceof MemoryDependencyError || error instanceof BrainMemoryWriteBusy ? error.code : undefined,
      },
      { status: error instanceof WorkCommandConflict || error instanceof MemoryDependencyError || error instanceof BrainMemoryWriteBusy ? error.status : 500 },
    );
  }
}
