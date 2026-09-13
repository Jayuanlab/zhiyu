import { auth } from "@/app/(auth)/auth";
import type { LoopTemplateId } from "@/lib/loops";
import {
  createWorkLoop,
  addWorkDirective,
  ensureWorkSelfAuditLoop,
  restoreWorkVersion,
  runWorkLoop,
  startWorkRun,
  updateWork,
  updateWorkLoop,
  updateWorkLoopActivation,
} from "@/lib/work-runtime";
import { NextResponse, type NextRequest } from "next/server";
import { WorkCommandConflict } from "@/lib/work-runtime/command-ledger";

export const dynamic = "force-dynamic";
export const maxDuration = 800;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
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

    const { id } = await params;
    const body = asRecord(await request.json().catch(() => ({})));
    const command = typeof body.command === "string" ? body.command : "";
    const meta = {
      commandId: typeof body.commandId === "string" ? body.commandId : undefined,
      expectedVersion: body.expectedVersion as number | undefined,
      source: "owner" as const,
      reason: typeof body.reason === "string" ? body.reason : null,
    };

    if (command === "updateWork") {
      const result = await updateWork({
        userId: session.user.id,
        workId: id,
        ...meta,
        patch: asRecord(body.patch),
      });
      return NextResponse.json({ ok: true, commandName: command, ...result });
    }

    if (command === "startWorkRun") {
      const result = await startWorkRun({
        userId: session.user.id,
        workId: id,
        ...meta,
        triggerReason: asRecord(body.triggerReason),
      });
      return NextResponse.json(
        { ok: true, commandName: command, ...result },
        { status: 202 },
      );
    }

    if (command === "createWorkLoop") {
      const result = await createWorkLoop({
        userId: session.user.id,
        workId: id,
        ...meta,
        type: body.type === "template" ? "template" : "natural_language",
        templateId:
          typeof body.templateId === "string"
            ? (body.templateId as LoopTemplateId)
            : undefined,
        templateInput: asRecord(body.templateInput),
        intent: typeof body.intent === "string" ? body.intent : undefined,
        timezone: typeof body.timezone === "string" ? body.timezone : undefined,
        externalWriteMode:
          body.externalWriteMode === "manual_approval"
            ? "manual_approval"
            : "loop_approved",
        create: body.create === true,
      });
      return NextResponse.json(
        { ok: true, commandName: command, ...result },
        { status: body.create === true || body.type === "template" ? 201 : 200 },
      );
    }

    if (command === "addWorkDirective") {
      const content = typeof body.content === "string" ? body.content : "";
      const result = await addWorkDirective({
        userId: session.user.id,
        workId: id,
        ...meta,
        content,
        priority: Number(body.priority ?? 0),
        scope: body.scope === "persistent" ? "persistent" : "current_run",
        runId: typeof body.runId === "string" ? body.runId : null,
        triggerRun: body.triggerRun !== false,
        triggerReason: asRecord(body.triggerReason),
      });
      return NextResponse.json(
        { ok: true, commandName: command, ...result },
        { status: 201 },
      );
    }

    if (command === "ensureWorkSelfAuditLoop") {
      const result = await ensureWorkSelfAuditLoop({
        userId: session.user.id,
        workId: id,
        ...meta,
        timezone: typeof body.timezone === "string" ? body.timezone : undefined,
        cronExpression:
          typeof body.cronExpression === "string"
            ? body.cronExpression
            : undefined,
      });
      return NextResponse.json(
        { ok: true, commandName: command, ...result },
        { status: result.created ? 201 : 200 },
      );
    }

    if (
      command === "updateWorkLoop" ||
      command === "activateWorkLoopProposal" ||
      command === "rejectWorkLoopProposal"
    ) {
      const loopId = typeof body.loopId === "string" ? body.loopId : "";
      if (!loopId) {
        return NextResponse.json({ error: "loopId is required" }, { status: 400 });
      }
      if (command === "updateWorkLoop") {
        const result = await updateWorkLoop({
          userId: session.user.id,
          workId: id,
          loopId,
          ...meta,
          patch: asRecord(body.patch),
        });
        return NextResponse.json({ ok: true, commandName: command, ...result });
      }
      const result = await updateWorkLoopActivation({
        userId: session.user.id,
        workId: id,
        loopId,
        ...meta,
        action:
          command === "activateWorkLoopProposal" ? "activate" : "reject",
        rejectionReason:
          typeof body.rejectionReason === "string"
            ? body.rejectionReason
            : meta.reason,
      });
      return NextResponse.json({ ok: true, commandName: command, ...result });
    }

    if (command === "runWorkLoop") {
      const loopId = typeof body.loopId === "string" ? body.loopId : "";
      if (!loopId) {
        return NextResponse.json({ error: "loopId is required" }, { status: 400 });
      }
      const result = await runWorkLoop({
        userId: session.user.id,
        workId: id,
        loopId,
        ...meta,
        mode: body.mode === "dry_run" ? "dry_run" : "native_agent",
        dryRun: body.dryRun === true,
        createOutboxDrafts:
          typeof body.createOutboxDrafts === "boolean"
            ? body.createOutboxDrafts
            : undefined,
      });
      return NextResponse.json({ ok: true, commandName: command, ...result });
    }

    if (command === "restoreWorkVersion") {
      const versionId = typeof body.versionId === "string" ? body.versionId : "";
      if (!versionId) {
        return NextResponse.json(
          { error: "versionId is required" },
          { status: 400 },
        );
      }
      const result = await restoreWorkVersion({
        userId: session.user.id,
        workId: id,
        versionId,
        ...meta,
      });
      return NextResponse.json({ ok: true, commandName: command, ...result });
    }

    return NextResponse.json(
      {
        error:
          "command must be updateWork, startWorkRun, addWorkDirective, createWorkLoop, updateWorkLoop, ensureWorkSelfAuditLoop, activateWorkLoopProposal, rejectWorkLoopProposal, runWorkLoop, or restoreWorkVersion",
      },
      { status: 400 },
    );
  } catch (error) {
    if (error instanceof WorkCommandConflict) return NextResponse.json({error: error.code}, {status: error.status});
    const message =
      error instanceof Error ? error.message : "Failed to execute Work command";
    const status = /not found/i.test(message) ? 404 : 500;
    console.error("[WorkCommandsAPI] POST error:", error);
    return NextResponse.json({ error: message }, { status });
  }
}
