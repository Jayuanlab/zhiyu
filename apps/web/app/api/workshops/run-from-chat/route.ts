import { auth } from "@/app/(auth)/auth";
import { NextResponse, type NextRequest } from "next/server";
import { WorkCommandConflict } from "@/lib/work-runtime/command-ledger";
import { executeNativeWorkshopRun, NativeWorkshopRunError, resolveOwnerClickedWorkshopRun } from "@/lib/ai/chat/native-workshop-run";

export const dynamic = "force-dynamic";
const keys = ["chatId", "workshopId", "requestId"];
export async function POST(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    if (request.headers.has("X-Work-Actor") && request.headers.get("X-Work-Actor") !== session.user.id) {
      return NextResponse.json({ ok: false, error: "actor_changed" }, { status: 409 });
    }
    const origin = request.headers.get("Origin");
    const publicOrigin = `${request.nextUrl.protocol}//${request.headers.get("Host") ?? request.nextUrl.host}`;
    if (origin && origin !== publicOrigin) return NextResponse.json({ ok: false, error: "cross_origin_request" }, { status: 403 });
    if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) return NextResponse.json({ ok: false, error: "invalid_request" }, { status: 400 });
    const body: unknown = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== keys.length
      || !keys.every(key => Object.hasOwn(body, key) && typeof (body as Record<string, unknown>)[key] === "string")) {
      return NextResponse.json({ ok: false, error: "invalid_request" }, { status: 400 });
    }
    const value = body as { chatId: string; workshopId: string; requestId: string };
    const binding = await resolveOwnerClickedWorkshopRun({ ownerId: session.user.id, ...value });
    const result = await executeNativeWorkshopRun(binding, undefined, request.signal);
    return NextResponse.json(result, { status: result.ok && ["queued", "running", "cancel_requested"].includes(result.run.status) ? 202 : 200,
      headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof NativeWorkshopRunError || error instanceof WorkCommandConflict) return NextResponse.json({ ok: false, error: error.code, message: error.message }, { status: error.status });
    console.error("[WorkshopRunFromChatAPI] request failed:", error);
    return NextResponse.json({ ok: false, error: "workshop_run_failed", message: "运行请求暂时无法核对，请重试同一个请求。" }, { status: 500 });
  }
}
