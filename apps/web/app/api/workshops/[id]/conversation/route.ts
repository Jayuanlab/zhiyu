import { auth } from "@/app/(auth)/auth";
import { listWorkConversation, submitWorkConversation, WorkConversationValidationError } from "@/lib/work-runtime/conversation";
import { WorkCommandConflict } from "@/lib/work-runtime/command-ledger";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };

function failure(error: unknown) {
  if (error instanceof WorkConversationValidationError) {
    return NextResponse.json({ error: error.message }, { status: 400, headers });
  }
  if (error instanceof WorkCommandConflict) {
    return NextResponse.json({ error: error.code }, { status: error.status, headers });
  }
  console.error("[WorkshopConversationAPI]", error);
  return NextResponse.json({ error: "对话暂时不可用，请稍后重试。" }, { status: 500, headers });
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await auth();
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
    const { id } = await params;
    return NextResponse.json(await listWorkConversation({ userId: session.user.id, workId: id }), { headers });
  } catch (error) { return failure(error); }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await auth();
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
    if (request.headers.has("X-Work-Actor") && request.headers.get("X-Work-Actor") !== session.user.id) {
      return NextResponse.json({ error: "actor_changed" }, { status: 409, headers });
    }
    let body: Record<string, unknown>;
    try {
      const value = await request.json();
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_body");
      body = value;
    } catch { return NextResponse.json({ error: "请求内容无效。" }, { status: 400, headers }); }
    const { id } = await params;
    return NextResponse.json(await submitWorkConversation({
      userId: session.user.id, workId: id,
      commandId: body.commandId ?? request.headers.get("Idempotency-Key"),
      content: body.content, parentRunId: body.parentRunId,
    }), { status: 201, headers });
  } catch (error) { return failure(error); }
}
