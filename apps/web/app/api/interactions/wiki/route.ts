import { auth } from "@/app/(auth)/auth";
import { actOnInteractionTask, TaskActionConflict, TaskActionInputError, validateTaskCommand, type TaskAction } from "@/lib/interactions/task-state";
import { MemoryDependencyError } from "@/lib/memory/revision/dependencies-common";
import { MemoryWriteBusy as BrainMemoryWriteBusy } from "@/lib/memory/kernel/reference-errors";
import {
  clearInteractionMemories,
  clearInteractionWikiItems,
  createInteractionBrainMemory,
  createInteractionNote,
  createInteractionSummaryNoteFromEvents,
  createInteractionTask,
  deleteInteractionWikiItem,
  listInteractionWiki,
  updateInteractionMemoryStatus,
  updateInteractionTaskStatus,
} from "@/lib/interactions/service";
import { NextResponse, type NextRequest } from "next/server";

export const dynamic = "force-dynamic";

function parseDate(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.map((item) => String(item)).filter(Boolean)
    : [];
}

function optionalTaskCommand(body: Record<string, unknown>) {
  const { commandId, expectedVersion } = body;
  if (commandId !== undefined) {
    if (typeof commandId !== "string") {
      throw new TaskActionInputError("commandId must be a non-empty string");
    }
    validateTaskCommand(commandId);
  }
  if (expectedVersion !== undefined && (
    typeof expectedVersion !== "number" || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0
  )) {
    throw new TaskActionInputError("expectedVersion must be a non-negative safe integer");
  }
  if (commandId !== undefined) validateTaskCommand(commandId, expectedVersion as number | undefined);
  return { commandId: commandId as string | undefined, expectedVersion: expectedVersion as number | undefined };
}

function requiredTaskCommand(body: Record<string, unknown>) {
  const command = optionalTaskCommand(body);
  if (command.commandId === undefined || command.expectedVersion === undefined) {
    throw new TaskActionInputError("commandId and expectedVersion are required");
  }
  return { commandId: command.commandId, expectedVersion: command.expectedVersion };
}

function writeFailure(error: unknown, fallback: string) {
  const known = error instanceof MemoryDependencyError || error instanceof BrainMemoryWriteBusy;
  const taskError = error instanceof TaskActionConflict || error instanceof TaskActionInputError;
  return NextResponse.json({
    error: known || taskError ? error.message : fallback,
    code: known ? error.code : undefined,
  }, { status: known ? error.status : error instanceof TaskActionConflict ? 409 : error instanceof TaskActionInputError ? 400 : 500 });
}

export async function GET(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const params = request.nextUrl.searchParams;
    const statuses = params
      .getAll("status")
      .flatMap((value) => value.split(","))
      .map((value) => value.trim())
      .filter(Boolean);
    const wiki = await listInteractionWiki({
      userId: session.user.id,
      limit: Number(params.get("limit") ?? 50),
      statuses: statuses.length > 0 ? statuses : undefined,
    });

    return NextResponse.json(wiki);
  } catch (error) {
    console.error("[InteractionWikiAPI] GET error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to load interaction wiki",
      },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const kind = String(body.kind ?? "");
    const sourceEventIds = stringArray(body.sourceEventIds);

    if (kind === "summary") {
      const note = await createInteractionSummaryNoteFromEvents({
        userId: session.user.id,
        eventIds: sourceEventIds,
        title: typeof body.title === "string" ? body.title : undefined,
      });
      return NextResponse.json({ note }, { status: 201 });
    }

    if (kind === "note") {
      const title = String(body.title ?? "").trim();
      const noteType = String(body.noteType ?? "summary").trim();
      const noteBody = String(body.body ?? "").trim();
      if (!title || !noteBody) {
        return NextResponse.json(
          { error: "title and body are required" },
          { status: 400 },
        );
      }
      const note = await createInteractionNote({
        userId: session.user.id,
        noteType,
        title,
        body: noteBody,
        memoryDependencies: body.memoryDependencies,
        memoryRequester: { type: "chat", userId: session.user.id, id: "interaction-wiki-api" },
        confidence: Number(body.confidence ?? 50),
        model: typeof body.model === "string" ? body.model : null,
        eventId: typeof body.eventId === "string" ? body.eventId : null,
        threadId: typeof body.threadId === "string" ? body.threadId : null,
        sourceEventIds,
        metadata:
          body.metadata && typeof body.metadata === "object"
            ? body.metadata
            : {},
      });
      return NextResponse.json({ note }, { status: 201 });
    }

    if (kind === "task") {
      const title = String(body.title ?? "").trim();
      if (!title) {
        return NextResponse.json(
          { error: "title is required" },
          { status: 400 },
        );
      }
      const command = optionalTaskCommand({ commandId: body.commandId });
      const task = await createInteractionTask({
        userId: session.user.id,
        commandId: command.commandId,
        title,
        description:
          typeof body.description === "string" ? body.description : null,
        memoryDependencies: body.memoryDependencies,
        memoryRequester: { type: "chat", userId: session.user.id, id: "interaction-wiki-api" },
        status: typeof body.status === "string" ? body.status : "candidate",
        dueAt: parseDate(body.dueAt),
        assigneeName:
          typeof body.assigneeName === "string" ? body.assigneeName : null,
        requesterName:
          typeof body.requesterName === "string" ? body.requesterName : null,
        confidence: Number(body.confidence ?? 50),
        eventId: typeof body.eventId === "string" ? body.eventId : null,
        threadId: typeof body.threadId === "string" ? body.threadId : null,
        sourceEventIds,
        metadata:
          body.metadata && typeof body.metadata === "object"
            ? body.metadata
            : {},
      });
      return NextResponse.json({ task }, { status: 201 });
    }

    if (kind === "memory") {
      const subject = String(body.subject ?? "").trim();
      const content = String(body.content ?? "").trim();
      const memoryType = String(body.memoryType ?? "project").trim();
      if (!subject || !content) {
        return NextResponse.json(
          { error: "subject and content are required" },
          { status: 400 },
        );
      }
      const memory = await createInteractionBrainMemory({
        userId: session.user.id,
        memoryType,
        subject,
        content,
        status: typeof body.status === "string" ? body.status : "candidate",
        confidence: Number(body.confidence ?? 50),
        tags: stringArray(body.tags),
        sourceEventIds,
        expiresAt: parseDate(body.expiresAt),
      });
      return NextResponse.json({ memory }, { status: 201 });
    }

    return NextResponse.json(
      { error: "kind must be summary, note, task, or memory" },
      { status: 400 },
    );
  } catch (error) {
    console.error("[InteractionWikiAPI] POST error:", error);
    return writeFailure(error, "Failed to create interaction wiki item");
  }
}

const allowedTaskStatuses = new Set([
  "candidate",
  "confirmed",
  "done",
  "dismissed",
  "deleted",
]);
const allowedMemoryStatuses = new Set([
  "candidate",
  "confirmed",
  "dismissed",
  "archived",
  "deleted",
]);

export async function PATCH(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const kind = String(body.kind ?? "");
    const id = String(body.id ?? "").trim();
    const status = String(body.status ?? "").trim();
    if (kind === "task" && body.action && id) {
      const command = requiredTaskCommand(body);
      const result = await actOnInteractionTask({userId: session.user.id, id,
        action: body.action as TaskAction, ...command, at: body.at});
      return NextResponse.json(result);
    }
    if (!id || !status) {
      return NextResponse.json(
        { error: "id and status are required" },
        { status: 400 },
      );
    }

    if (kind === "task") {
      if (!allowedTaskStatuses.has(status)) {
        return NextResponse.json(
          { error: "invalid task status" },
          { status: 400 },
        );
      }
      const task = await updateInteractionTaskStatus({
        userId: session.user.id,
        id,
        status,
        ...requiredTaskCommand(body),
      });
      return NextResponse.json({ task });
    }

    if (kind === "memory") {
      if (!allowedMemoryStatuses.has(status)) {
        return NextResponse.json(
          { error: "invalid memory status" },
          { status: 400 },
        );
      }
      const memory = await updateInteractionMemoryStatus({
        userId: session.user.id,
        id,
        status,
      });
      return NextResponse.json({ memory });
    }

    return NextResponse.json(
      { error: "kind must be task or memory" },
      { status: 400 },
    );
  } catch (error) {
    console.error("[InteractionWikiAPI] PATCH error:", error);
    return writeFailure(error, "Failed to update interaction wiki item");
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const action = String(body.action ?? "").trim();
    const reason =
      typeof body.reason === "string" && body.reason.trim()
        ? body.reason.trim()
        : null;

    if (action === "clear_memories") {
      const result = await clearInteractionMemories({
        userId: session.user.id,
        reason,
      });
      return NextResponse.json(result);
    }

    if (action === "clear_all") {
      const result = await clearInteractionWikiItems({
        userId: session.user.id,
        reason,
      });
      return NextResponse.json(result);
    }

    const kind = String(body.kind ?? "").trim();
    const id = String(body.id ?? "").trim();
    if (!["note", "task", "memory"].includes(kind) || !id) {
      return NextResponse.json(
        { error: "kind must be note, task, or memory; id is required" },
        { status: 400 },
      );
    }

    const result = await deleteInteractionWikiItem({
      userId: session.user.id,
      kind: kind as "note" | "task" | "memory",
      id,
      reason,
      ...(kind === "task" ? optionalTaskCommand(body) : {}),
    });
    return NextResponse.json(result);
  } catch (error) {
    console.error("[InteractionWikiAPI] DELETE error:", error);
    return writeFailure(error, "Failed to delete interaction wiki item");
  }
}
