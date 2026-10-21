import { auth } from "@/app/(auth)/auth";
import { inspectWorkshopMemoryRecallQuality, synchronizeWorkshopMemoryRecallQualityReviews } from "@/lib/workshops/memory-recall-quality";
import { NextResponse, type NextRequest } from "next/server";

export const dynamic = "force-dynamic";

function boundedInt(value: string | null, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const { id } = await params;
    const searchParams = request.nextUrl.searchParams;
    const report = await inspectWorkshopMemoryRecallQuality({
      userId: session.user.id,
      workshopId: id,
      days: boundedInt(searchParams.get("days"), 7, 1, 30),
      maxContextLogs: boundedInt(
        searchParams.get("maxContextLogs"),
        500,
        10,
        2_000,
      ),
      requireStewardRole: false,
      syncReviewItems: false,
    });
    return NextResponse.json(report);
  } catch (error) {
    console.error("[WorkshopMemoryRecallQualityAPI] GET error:", error);
    if (error instanceof Error && error.message === "Workshop not found") return NextResponse.json({ error: "Workshop unavailable" }, { status: 404 });
    return NextResponse.json(
      {
        error: "Memory quality report is unavailable",
      },
      { status: 503 },
    );
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  if (!body || typeof body !== "object" || Array.isArray(body)
    || Object.keys(body).some(key => key !== "action")
    || (body as { action?: unknown }).action !== "sync_review_items")
    return NextResponse.json({ error: "An explicit sync_review_items action is required" }, { status: 400 });
  try {
    const { id } = await params;
    const report = await synchronizeWorkshopMemoryRecallQualityReviews({ userId: session.user.id, workshopId: id });
    return NextResponse.json(report);
  } catch (error) {
    if (error instanceof Error && error.message === "Workshop not found") return NextResponse.json({ error: "Workshop unavailable" }, { status: 404 });
    return NextResponse.json({ error: "Memory quality review synchronization failed" }, { status: 503 });
  }
}
