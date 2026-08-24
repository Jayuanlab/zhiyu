import { auth } from "@/app/(auth)/auth";
import { inspectWorkshopMemoryRecallQuality } from "@/lib/workshops/memory-recall-quality";
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
      syncReviewItems: true,
    });
    return NextResponse.json(report);
  } catch (error) {
    console.error("[WorkshopMemoryRecallQualityAPI] GET error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to load memory recall quality",
      },
      { status: 500 },
    );
  }
}
