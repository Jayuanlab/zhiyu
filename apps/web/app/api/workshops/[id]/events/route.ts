import { auth } from "@/app/(auth)/auth";
import { listWorkEvents } from "@/lib/work-runtime";
import { NextResponse, type NextRequest } from "next/server";

export const dynamic = "force-dynamic";

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
    const after = request.nextUrl.searchParams.get("after");
    const before = request.nextUrl.searchParams.get("before");
    const history = request.nextUrl.searchParams.get('pagination') === 'history';
    const limit = Number(request.nextUrl.searchParams.get('limit') ?? 100);
    const validCursor = (value:string|null) => value === null || (/^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) >= 0);
    if (!validCursor(after) || !validCursor(before) || (after !== null && before !== null) || (history && after !== null) || !Number.isInteger(limit) || limit < 1 || limit > 2000)
      return NextResponse.json({error:'Invalid event pagination'},{status:400});
    const runId = request.nextUrl.searchParams.get("runId");
    if (runId && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(runId)) {
      return NextResponse.json({error: "Invalid runId"}, {status: 400});
    }
    const events = await listWorkEvents({
      runId: runId || undefined,
      userId: session.user.id,
      workId: id,
      afterSeq: after ? Number(after) : undefined,
      beforeSeq: before !== null ? Number(before) : undefined,
      limit: limit + (history ? 1 : 0),
      order: after ? "asc" : "latest",
    });

    if(history){
      const hasMore=events.length>limit;
      const page=hasMore?events.slice(1):events;
      return NextResponse.json({events:page,hasMore,nextBefore:hasMore?page[0].seq:null},{headers:{'Cache-Control':'no-store'}});
    }
    return NextResponse.json({ events });
  } catch (error) {
    console.error("[WorkshopEventsAPI] GET error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load workshop events" },
      { status: 500 },
    );
  }
}
