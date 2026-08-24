import {
  fetchQuantPaperOrders,
  placeQuantPaperOrder,
} from "@/lib/quant/client";
import { invalidateQuantReadCache } from "@/lib/quant/cache";
import type { QuantPaperOrderInput } from "@/lib/quant/types";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const limit = Number(url.searchParams.get("limit") ?? "100");
    const orders = await fetchQuantPaperOrders(limit);
    return NextResponse.json(orders);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "模拟盘订单暂不可用";
    return NextResponse.json({ error: message }, { status: 503 });
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as QuantPaperOrderInput;
    const result = await placeQuantPaperOrder({
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
      actor: body.actor ? String(body.actor) : "workshop-agent",
    });
    invalidateQuantReadCache(["quant:dashboard", "quant:paper:account"]);
    return NextResponse.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "模拟委托提交失败";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
