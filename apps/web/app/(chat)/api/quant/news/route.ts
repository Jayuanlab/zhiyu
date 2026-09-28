import { auth } from "@/app/(auth)/auth";
import { cachedQuantRead } from "@/lib/quant/cache";
import { fetchQuantNews } from "@/lib/quant/client";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const code = url.searchParams.get("code")?.trim() || undefined;
  const pageSize = Number(url.searchParams.get("pageSize") ?? 8);
  const safePageSize = Number.isFinite(pageSize)
    ? Math.max(1, Math.min(20, pageSize))
    : 8;
  const cacheKey = `quant:news:${code ?? "market"}:${safePageSize}`;

  try {
    const snapshot = await cachedQuantRead({
      key: cacheKey,
      ttlMs: 60_000,
      staleTtlMs: 10 * 60_000,
      fetcher: () => fetchQuantNews({ code, pageSize: safePageSize }),
    });
    return NextResponse.json(snapshot);
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "量化资讯暂不可用",
      },
      { status: 503 },
    );
  }
}
