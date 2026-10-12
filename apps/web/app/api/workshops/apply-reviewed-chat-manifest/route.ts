import { auth } from "@/app/(auth)/auth";
import { NextResponse, type NextRequest } from "next/server";
import { WorkCommandConflict } from "@/lib/work-runtime/command-ledger";
import { WorkshopManifestApplicationError } from "@/lib/ai/chat/native-workshop-manifest-application";
import {
  executeReviewedWorkshopManifestApplication,
  resolveOwnerClickedWorkshopManifestApplication,
  type ReviewedWorkshopManifestRequest,
} from "@/lib/ai/chat/reviewed-workshop-manifest-application";

export const dynamic = "force-dynamic";
const requestKeys = ["chatId", "reviewAssistantMessageId", "reviewToolCallId", "manifestSha256"];

export async function POST(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    if (request.headers.has("X-Work-Actor") && request.headers.get("X-Work-Actor") !== session.user.id) {
      return NextResponse.json({ ok: false, error: "actor_changed" }, { status: 409 });
    }
    const origin = request.headers.get("Origin");
    // NextURL normalizes loopback hosts to localhost. Preserve the browser's
    // original authority; a forwarded host cannot grant cross-origin access.
    const publicHost = request.headers.get("Host") ?? request.nextUrl.host;
    const publicOrigin = `${request.nextUrl.protocol}//${publicHost}`;
    if (origin && origin !== publicOrigin) {
      return NextResponse.json({ ok: false, error: "cross_origin_request" }, { status: 403 });
    }
    if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) {
      return NextResponse.json({ ok: false, error: "invalid_request" }, { status: 400 });
    }
    const body: unknown = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)
      || Object.keys(body).length !== requestKeys.length
      || !requestKeys.every(key => Object.hasOwn(body, key) && typeof (body as Record<string, unknown>)[key] === "string")) {
      return NextResponse.json({ ok: false, error: "invalid_request", message: "请选择对话中最新审核通过的配置。" }, { status: 400 });
    }
    const binding = await resolveOwnerClickedWorkshopManifestApplication(session.user.id, body as ReviewedWorkshopManifestRequest);
    const result = await executeReviewedWorkshopManifestApplication(binding, undefined, request.signal);
    return NextResponse.json(result, { status: result.ok ? 201 : 200 });
  } catch (error) {
    if (error instanceof WorkshopManifestApplicationError) {
      return NextResponse.json({ ok: false, error: error.code, message: error.message }, { status: error.status });
    }
    if (error instanceof WorkCommandConflict) {
      return NextResponse.json({ ok: false, error: error.code, message: error.message }, { status: error.status });
    }
    console.error("[ReviewedChatWorkshopManifestAPI] application failed:", error);
    return NextResponse.json({ ok: false, error: "workshop_apply_failed", message: error instanceof Error ? error.message : "应用失败，请重试。" }, { status: 500 });
  }
}
