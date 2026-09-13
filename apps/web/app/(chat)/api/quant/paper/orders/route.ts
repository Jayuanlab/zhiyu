import {
  fetchQuantPaperOrders,
  placeQuantPaperOrder,
} from "@/lib/quant/client";
import { invalidateQuantReadCache } from "@/lib/quant/cache";
import type { QuantPaperOrderInput } from "@/lib/quant/types";
import { NextResponse } from "next/server";
import { auth } from "@/app/(auth)/auth";
import {PaperCommandError} from "@/lib/quant/paper-client";

export async function GET(request: Request) {
  const session=await auth();
  if(!session?.user?.id)return NextResponse.json({error:'Unauthorized'},{status:401});
  try {
    const url = new URL(request.url);
    const limit = Number(url.searchParams.get("limit") ?? "100");
    const orders = await fetchQuantPaperOrders(limit,session.user.id);
    return NextResponse.json(orders);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "模拟盘订单暂不可用";
    return NextResponse.json({ error: message }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const body = (await request.json()) as QuantPaperOrderInput;
    const commandId=body.commandId??request.headers.get('Idempotency-Key');
    if(typeof commandId!=='string'||!commandId.trim()||commandId.length>200||(request.headers.has('Idempotency-Key')&&request.headers.get('Idempotency-Key')!==commandId))return NextResponse.json({error:'invalid_command'},{status:400});
    if(request.headers.has('X-Work-Actor')&&request.headers.get('X-Work-Actor')!==session.user.id)return NextResponse.json({error:'identity_changed'},{status:409});
    const result = await placeQuantPaperOrder({
      commandId,accountId:body.accountId,expectedVersion:body.expectedVersion,tradeThesis:body.tradeThesis,
      code: String(body.code ?? ""),
      side: body.side,
      quantity: Number(body.quantity),
      limit_price: Number(body.limit_price),
      planned_price:
        body.planned_price === undefined ? undefined : Number(body.planned_price),
      max_buy_deviation_pct:
        body.max_buy_deviation_pct === undefined
          ? undefined
          : Number(body.max_buy_deviation_pct),
      note: body.note ? String(body.note) : undefined,
      strategy: body.strategy ? String(body.strategy) : undefined,
      actor: `user:${session.user.id}`,
    },{ownerId:session.user.id,actorId:`user:${session.user.id}`,role:'owner'});
    invalidateQuantReadCache(["quant:dashboard", `quant:paper:account:${session.user.id}`]);
    return NextResponse.json(result);
  } catch (error) {
    if(error instanceof PaperCommandError)return NextResponse.json({error:error.code,commandId:error.commandId,receipt:error.receipt},{status:error.status});
    const message =
      error instanceof Error ? error.message : "模拟委托提交失败";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
