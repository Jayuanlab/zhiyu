import { auth } from "@/app/(auth)/auth";
import { sendWorkOutbox } from "@/lib/work-runtime";
import { NextResponse, type NextRequest } from "next/server";
import {WorkCommandConflict} from '@/lib/work-runtime/command-ledger';

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; outboxId: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id, outboxId } = await params;
    if(request.headers.has('X-Work-Actor')&&request.headers.get('X-Work-Actor')!==session.user.id)return NextResponse.json({error:'actor_changed'},{status:409});
    const body=await request.json().catch(()=>null);
    if(!body||typeof body.expectedContentHash!=='string'||!/^[a-f0-9]{64}$/.test(body.expectedContentHash))return NextResponse.json({error:'Current preview is required'},{status:400});
    const result = await sendWorkOutbox({
      userId: session.user.id,
      workId: id,
      outboxId,
      expectedContentHash:body.expectedContentHash,
      source: "owner",
      reason: "Outbox send requested from workshop API.",
    });
    return NextResponse.json(result, { status: result.ok ? 200 : 400 });
  } catch (error) {
    console.error("[WorkshopOutboxSendAPI] POST error:", error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Failed to send outbox" },
      { status: error instanceof WorkCommandConflict?error.status:400 },
    );
  }
}
