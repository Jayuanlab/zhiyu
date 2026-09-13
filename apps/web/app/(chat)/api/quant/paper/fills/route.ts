import { fetchQuantPaperFills } from "@/lib/quant/client";
import { NextResponse } from "next/server";
import {auth} from '@/app/(auth)/auth';

export async function GET(request: Request) {
  const session=await auth();
  if(!session?.user?.id)return NextResponse.json({error:'Unauthorized'},{status:401});
  try {
    const url = new URL(request.url);
    const limit = Number(url.searchParams.get("limit") ?? "100");
    const fills = await fetchQuantPaperFills(limit,session.user.id);
    return NextResponse.json(fills);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "模拟盘成交暂不可用";
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
