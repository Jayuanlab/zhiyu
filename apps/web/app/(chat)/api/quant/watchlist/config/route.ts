import {
  cachedQuantRead,
  invalidateQuantReadCache,
} from "@/lib/quant/cache";
import {
  fetchQuantWatchlistConfig,
  updateQuantWatchlistConfig,
} from "@/lib/quant/client";
import { NextResponse } from "next/server";
import { auth } from "@/app/(auth)/auth";

export async function GET() {
  try {
    const config = await cachedQuantRead({
      key: "quant:watchlist:config",
      fetcher: fetchQuantWatchlistConfig,
    });
    return NextResponse.json(config);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Quant watchlist unavailable";
    return NextResponse.json({ error: message }, { status: 503 });
  }
}

export async function PUT(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const body = (await request.json()) as { codes?: unknown; items?: unknown };
    const codes = Array.isArray(body.codes)
      ? body.codes.map((code) => String(code))
      : [];
    const items = Array.isArray(body.items)
      ? body.items.filter(
          (item): item is Record<string, unknown> =>
            Boolean(item) && typeof item === "object" && !Array.isArray(item),
        )
      : undefined;
    const config = await updateQuantWatchlistConfig(codes, items as any);
    invalidateQuantReadCache([
      "quant:watchlist:config",
      "quant:dashboard",
      "quant:paper:account",
    ]);
    return NextResponse.json(config);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to update watchlist";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
