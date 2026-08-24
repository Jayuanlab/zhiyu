import { invalidateQuantReadCache } from "@/lib/quant/cache";
import { cancelQuantPaperOrder } from "@/lib/quant/client";
import { NextResponse } from "next/server";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ orderId: string }> },
) {
  try {
    const { orderId } = await params;
    const result = await cancelQuantPaperOrder(orderId);
    invalidateQuantReadCache(["quant:dashboard", "quant:paper:account"]);
    return NextResponse.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "模拟委托撤销失败";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
