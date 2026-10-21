import { auth } from "@/app/(auth)/auth";
import { NativeWorkshopRunError } from "@/lib/ai/chat/native-workshop-run";
import { OwnerLoopRunError } from "@/lib/loops/owner-loop-run";
import { promoteWorkingMemory } from "@/lib/workshops/working-memory-promotion-service";
import { WorkingMemoryPromotionError } from "@/lib/workshops/working-memory-promotion";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await auth();
    if (!session?.user?.id) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    const { id } = await params;
    let command: unknown;
    try { command = await request.json(); } catch { throw new WorkingMemoryPromotionError("invalid_promotion_command", "提交内容不是有效 JSON。", 400); }
    const result = await promoteWorkingMemory({ userId: session.user.id, workshopId: id, command });
    return NextResponse.json({ ok: true, ...result }, { status: result.replayed ? 200 : 201, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof NativeWorkshopRunError || error instanceof OwnerLoopRunError || error instanceof WorkingMemoryPromotionError)
      return NextResponse.json({ ok: false, error: error.code, message: error.message }, { status: error.status });
    console.error("[WorkingMemoryPromotion] candidate admission failed:", error);
    return NextResponse.json({ ok: false, error: "working_memory_promotion_failed", message: "长期候选提交未确认，请重试同一指令或到记忆审核页核对。" }, { status: 500 });
  }
}
