import { auth } from "@/app/(auth)/auth";
import { NextResponse } from "next/server";
import { getReviewAssistant, generateReviewAssistant, getSavedReviewAssistantResult, ReviewAssistantError } from "@/lib/workshops/review-assistant-service";
import { applyReviewAssistantDecisions, getReviewAssistantDecisions, restoreReviewAssistantDecision } from "@/lib/workshops/review-assistant-decisions";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
function failure(error: unknown) {
  if (error instanceof ReviewAssistantError) return NextResponse.json({ error: error.code }, { status: error.status, headers });
  console.error("[ReviewAssistant] request could not be completed");
  return NextResponse.json({ error: "助审暂时不可用，请稍后重试。" }, { status: 500, headers });
}
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await auth();
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
    const { id } = await params;
    const response = await getReviewAssistant({ userId: session.user.id, workId: id });
    const decisions = await getReviewAssistantDecisions(session.user.id, id);
    return NextResponse.json({ ...response, decisions }, { headers });
  } catch (error) { return failure(error); }
}
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await auth();
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
    if (request.headers.has("X-Work-Actor") && request.headers.get("X-Work-Actor") !== session.user.id) {
      return NextResponse.json({ error: "actor_changed" }, { status: 409, headers });
    }
    if (Number(request.headers.get("Content-Length")) > 1024) throw new ReviewAssistantError("invalid_request", 400);
    const text = await request.text();
    if (text.length > 1024) throw new ReviewAssistantError("invalid_request", 400);
    let body: unknown;
    try { body = JSON.parse(text); } catch { throw new ReviewAssistantError("invalid_request", 400); }
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => key !== "fingerprint")) throw new ReviewAssistantError("invalid_request", 400);
    const { id } = await params;
    const fingerprint = (body as { fingerprint?: unknown }).fingerprint;
    const response = await generateReviewAssistant({ userId: session.user.id, workId: id, fingerprint });
    if (response.mode === "ai" && typeof fingerprint === "string") {
      const result = await getSavedReviewAssistantResult(session.user.id, id, fingerprint);
      if (result) await applyReviewAssistantDecisions({ userId: session.user.id, workId: id, fingerprint, response, result });
    }
    const current = await getReviewAssistant({ userId: session.user.id, workId: id });
    const decisions = await getReviewAssistantDecisions(session.user.id, id);
    return NextResponse.json({ ...current, decisions }, { headers });
  } catch (error) { return failure(error); }
}
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await auth();
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
    if (request.headers.has("X-Work-Actor") && request.headers.get("X-Work-Actor") !== session.user.id) return NextResponse.json({ error: "actor_changed" }, { status: 409, headers });
    if (Number(request.headers.get("Content-Length")) > 512) throw new ReviewAssistantError("invalid_request", 400);
    const text = await request.text();
    if (text.length > 512) throw new ReviewAssistantError("invalid_request", 400);
    let body: unknown;
    try { body = JSON.parse(text); } catch { throw new ReviewAssistantError("invalid_request", 400); }
    if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).some(key => !["itemId", "decisionEventId"].includes(key))) throw new ReviewAssistantError("invalid_request", 400);
    const { id } = await params;
    await restoreReviewAssistantDecision({ userId: session.user.id, workId: id,
      itemId: (body as { itemId?: string }).itemId ?? "", decisionEventId: (body as { decisionEventId?: string }).decisionEventId ?? "" });
    const response = await getReviewAssistant({ userId: session.user.id, workId: id });
    const decisions = await getReviewAssistantDecisions(session.user.id, id);
    return NextResponse.json({ ...response, decisions }, { headers });
  } catch (error) { return failure(error); }
}
