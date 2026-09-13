import { invalidateQuantReadCache } from "@/lib/quant/cache";
import { cancelQuantPaperOrder } from "@/lib/quant/client";
import { NextResponse } from "next/server";
import { auth } from "@/app/(auth)/auth";
import {PaperCommandError} from "@/lib/quant/paper-client";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ orderId: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const { orderId } = await params;
    const body=await request.json();
    const commandId=body.commandId??request.headers.get('Idempotency-Key');
    if(typeof commandId!=='string'||!commandId.trim()||commandId.length>200||(request.headers.has('Idempotency-Key')&&request.headers.get('Idempotency-Key')!==commandId))return NextResponse.json({error:'invalid_command'},{status:400});
    if(request.headers.has('X-Work-Actor')&&request.headers.get('X-Work-Actor')!==session.user.id)return NextResponse.json({error:'identity_changed'},{status:409});
    const result = await cancelQuantPaperOrder(orderId,{commandId,accountId:body.accountId,expectedVersion:body.expectedVersion,reason:body.reason},{ownerId:session.user.id,actorId:`user:${session.user.id}`,role:'owner'});
    invalidateQuantReadCache(["quant:dashboard", `quant:paper:account:${session.user.id}`]);
    return NextResponse.json(result);
  } catch (error) {
    if(error instanceof PaperCommandError)return NextResponse.json({error:error.code,commandId:error.commandId,receipt:error.receipt},{status:error.status});
    const message =
      error instanceof Error ? error.message : "模拟委托撤销失败";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
