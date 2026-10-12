import { auth } from "@/app/(auth)/auth";
import { readOwnerWorkshopRun, NativeWorkshopRunError } from "@/lib/ai/chat/native-workshop-run";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export async function GET(_request: Request, { params }: { params: Promise<{ id: string; runId: string }> }) {
  try {
    const session = await auth();
    if (!session?.user?.id) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    const { id, runId } = await params;
    return NextResponse.json(await readOwnerWorkshopRun({ ownerId: session.user.id, workshopId: id, runId }),
      { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof NativeWorkshopRunError) return NextResponse.json({ ok: false, error: error.code, message: error.message }, { status: error.status });
    console.error("[WorkshopExactRunAPI] read failed:", error);
    return NextResponse.json({ ok: false, error: "workshop_run_read_failed", message: "这轮运行暂时无法读取，请稍后重试。" }, { status: 500 });
  }
}
