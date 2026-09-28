import { auth } from "@/app/(auth)/auth";
import { listWorkEvents, listWorkRuns } from "@/lib/work-runtime";
import { buildWorkPresentation } from "@/lib/workshops/work-presentation";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const EVENT_LIMIT = 2000;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const { id } = await params;
    const result = await listWorkRuns({ userId: session.user.id, workId: id, limit: 1 });
    if (!result) {
      return NextResponse.json({ error: "Work not found" }, { status: 404 });
    }
    const run = result.runs[0] ?? null;
    if (!run) {
      return NextResponse.json({ presentation: null, run: null, hasMoreEvents: false },
        { headers: { "Cache-Control": "private, no-store" } });
    }
    const fetched = await listWorkEvents({
      userId: session.user.id, workId: id, runId: run.id,
      limit: EVENT_LIMIT + 1, order: "latest",
    });
    const hasMoreEvents = fetched.length > EVENT_LIMIT;
    const events = hasMoreEvents ? fetched.slice(1) : fetched;
    const projected = buildWorkPresentation({ workshopId: id, run, events });
    const presentation = projected && hasMoreEvents
      ? { ...projected, warnings: [...projected.warnings,
          `本轮事件超过 ${EVENT_LIMIT} 条；汇报只读取最近记录，较早的产物请到工作记录核对。`] }
      : projected;
    return NextResponse.json({ presentation, run: {
      id: run.id, status: run.status, createdAt: run.createdAt,
      completedAt: run.completedAt,
    }, hasMoreEvents }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("[WorkshopPresentationAPI] GET error:", error);
    return NextResponse.json({ error: "工作汇报读取失败" }, { status: 500 });
  }
}
